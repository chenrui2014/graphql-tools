import {
  DocumentNode,
  GraphQLField,
  GraphQLInputObjectType,
  GraphQLNamedType,
  GraphQLObjectType,
  GraphQLResolveInfo,
  GraphQLInterfaceType,
  GraphQLSchema,
  GraphQLType,
  GraphQLString,
  GraphQLNonNull,
  GraphQLList,
  extendSchema,
  getNamedType,
  isCompositeType,
  isNamedType,
  parse,
  InlineFragmentNode,
  Kind,
  GraphQLScalarType,
} from 'graphql';
import {
  IResolvers,
  MergeInfo,
  IFieldResolver,
  VisitType,
  MergeTypeCandidate,
  TypeWithResolvers,
  VisitTypeResult,
  ResolveType,
} from '../Interfaces';
// import isEmptyObject from '../isEmptyObject';
import {
  extractExtensionDefinitions,
  addResolveFunctionsToSchema,
} from '../schemaGenerator';
import {
  recreateCompositeType,
  fieldMapToFieldConfigMap,
} from './schemaRecreation';
import delegateToSchema from './delegateToSchema';
import typeFromAST, { GetType } from './typeFromAST';

export default function mergeSchemas({
  schemas,
  visitType,
  resolvers,
}: {
  schemas: Array<{ name: string; schema: string | GraphQLSchema }>;
  visitType?: VisitType;
  resolvers?: IResolvers | ((mergeInfo: MergeInfo) => IResolvers);
}): GraphQLSchema {
  const allSchemas: { [name: string]: GraphQLSchema } = {};
  const typeCandidates: { [name: string]: Array<MergeTypeCandidate> } = {};
  const types: { [name: string]: GraphQLNamedType } = {};
  const extensions: Array<DocumentNode> = [];
  const fragments = {};

  if (!visitType) {
    visitType = defaultVisitType;
  }

  const resolveType = createResolveType(name => {
    if (types[name] === undefined) {
      throw new Error(`Can't find type ${name}.`);
    }
    return types[name];
  });

  const createNamedStub: GetType = (name, type) => {
    let constructor: any;
    if (type === 'object') {
      constructor = GraphQLObjectType;
    } else if (type === 'interface') {
      constructor = GraphQLInterfaceType;
    } else {
      constructor = GraphQLInputObjectType;
    }
    return new constructor({
      name,
      fields: {
        __fake: {
          type: GraphQLString,
        },
      },
    });
  };

  schemas.forEach(subSchema => {
    if (subSchema.schema instanceof GraphQLSchema) {
      const schema = subSchema.schema;
      allSchemas[subSchema.name] = schema;
      const queryType = schema.getQueryType();
      const mutationType = schema.getMutationType();
      const subscriptionType = schema.getSubscriptionType();
      addTypeCandidate(typeCandidates, 'Query', {
        schemaName: subSchema.name,
        schema,
        type: queryType,
      });
      if (mutationType) {
        addTypeCandidate(typeCandidates, 'Mutation', {
          schemaName: subSchema.name,
          schema,
          type: mutationType,
        });
      }
      if (subscriptionType) {
        addTypeCandidate(typeCandidates, 'Subscription', {
          schemaName: subSchema.name,
          schema,
          type: subscriptionType,
        });
      }

      const typeMap = schema.getTypeMap();
      Object.keys(typeMap).forEach(typeName => {
        const type: GraphQLNamedType = typeMap[typeName];
        if (
          isNamedType(type) &&
          getNamedType(type).name.slice(0, 2) !== '__' &&
          type !== queryType &&
          type !== mutationType &&
          type !== subscriptionType
        ) {
          addTypeCandidate(typeCandidates, type.name, {
            schemaName: subSchema.name,
            schema,
            type: type,
          });
        }
      });
    } else if (typeof subSchema.schema === 'string') {
      let parsedSchemaDocument = parse(subSchema.schema);
      parsedSchemaDocument.definitions.forEach(def => {
        const type = typeFromAST(def, createNamedStub);
        if (type) {
          addTypeCandidate(typeCandidates, type.name, {
            schemaName: subSchema.name,
            type: type,
          });
        }
      });

      const extensionsDocument = extractExtensionDefinitions(
        parsedSchemaDocument,
      );
      if (extensionsDocument.definitions.length > 0) {
        extensions.push(extensionsDocument);
      }
    } else {
      throw new Error(`Invalid schema ${subSchema.name}`);
    }
  });

  let generatedResolvers = {};

  Object.keys(typeCandidates).forEach(typeName => {
    const resultType: VisitTypeResult = visitType(
      typeName,
      typeCandidates[typeName],
    );
    if (resultType === null) {
      types[typeName] = null;
    } else {
      let type: GraphQLNamedType;
      let typeResolvers: IResolvers;
      if (isNamedType(<GraphQLNamedType>resultType)) {
        type = <GraphQLNamedType>resultType;
      } else if ((<TypeWithResolvers>resultType).type) {
        type = (<TypeWithResolvers>resultType).type;
        typeResolvers = (<TypeWithResolvers>resultType).resolvers;
      } else {
        throw new Error('Invalid `visitType` result for type "${typeName}"');
      }
      let newType: GraphQLType;
      if (isCompositeType(type) || type instanceof GraphQLInputObjectType) {
        newType = recreateCompositeType(type, resolveType);
      } else {
        newType = getNamedType(type);
      }
      types[typeName] = newType;
      if (typeResolvers) {
        generatedResolvers[typeName] = typeResolvers;
      }
    }
  });

  let mergedSchema = new GraphQLSchema({
    query: types.Query as GraphQLObjectType,
    mutation: types.Mutation as GraphQLObjectType,
    subscription: types.Subscription as GraphQLObjectType,
    types: Object.keys(types).map(key => types[key]),
  });

  extensions.forEach(extension => {
    mergedSchema = extendSchema(mergedSchema, extension);
  });

  Object.keys(resolvers).forEach(typeName => {
    const type = resolvers[typeName];
    if (type instanceof GraphQLScalarType) {
      return;
    }
    Object.keys(type).forEach(fieldName => {
      const field = type[fieldName];
      if (field.fragment) {
        fragments[typeName] = fragments[typeName] || {};
        fragments[typeName][fieldName] = parseFragmentToInlineFragment(
          field.fragment,
        );
      }
    });
  });

  addResolveFunctionsToSchema(
    mergedSchema,
    mergeDeep(generatedResolvers, resolvers),
  );

  const mergeInfo = createMergeInfo(allSchemas, fragments);
  forEachField(mergedSchema, field => {
    if (field.resolve) {
      const fieldResolver = field.resolve;
      field.resolve = (parent, args, context, info) => {
        const newInfo = { ...info, mergeInfo };
        return fieldResolver(parent, args, context, newInfo);
      };
    }
  });

  return mergedSchema;
}

function createResolveType(
  getType: (name: string, type: GraphQLType) => GraphQLType | null,
): ResolveType<any> {
  const resolveType = <T extends GraphQLType>(type: T): T => {
    if (type instanceof GraphQLList) {
      const innerType = resolveType(type.ofType);
      if (innerType === null) {
        return null;
      } else {
        return new GraphQLList(innerType) as T;
      }
    } else if (type instanceof GraphQLNonNull) {
      const innerType = resolveType(type.ofType);
      if (innerType === null) {
        return null;
      } else {
        return new GraphQLNonNull(innerType) as T;
      }
    } else if (isNamedType(type)) {
      return getType(getNamedType(type).name, type) as T;
    } else {
      return type;
    }
  };
  return resolveType;
}

function createMergeInfo(
  schemas: { [name: string]: GraphQLSchema },
  fragmentReplacements: {
    [name: string]: { [fieldName: string]: InlineFragmentNode };
  },
): MergeInfo {
  return {
    getSubSchema(schemaName: string): GraphQLSchema {
      const schema = schemas[schemaName];
      if (!schema) {
        throw new Error(`No subschema named ${schemaName}.`);
      }
      return schema;
    },
    delegate(
      schemaName: string,
      operation: 'query' | 'mutation' | 'subscription',
      fieldName: string,
      args: { [key: string]: any },
      context: { [key: string]: any },
      info: GraphQLResolveInfo,
    ): any {
      const schema = schemas[schemaName];
      if (!schema) {
        throw new Error(`No subschema named ${schemaName}.`);
      }
      return delegateToSchema(
        schema,
        fragmentReplacements,
        operation,
        fieldName,
        args,
        context,
        info,
      );
    },
  };
}

function createDelegatingResolver(
  schemaName: string,
  operation: 'query' | 'mutation' | 'subscription',
  fieldName: string,
): IFieldResolver<any, any> {
  return (root, args, context, info) => {
    return info.mergeInfo.delegate(
      schemaName,
      operation,
      fieldName,
      args,
      context,
      info,
    );
  };
}

type FieldIteratorFn = (
  fieldDef: GraphQLField<any, any>,
  typeName: string,
  fieldName: string,
) => void;

function forEachField(schema: GraphQLSchema, fn: FieldIteratorFn): void {
  const typeMap = schema.getTypeMap();
  Object.keys(typeMap).forEach(typeName => {
    const type = typeMap[typeName];

    if (
      !getNamedType(type).name.startsWith('__') &&
      type instanceof GraphQLObjectType
    ) {
      const fields = type.getFields();
      Object.keys(fields).forEach(fieldName => {
        const field = fields[fieldName];
        fn(field, typeName, fieldName);
      });
    }
  });
}

function isObject(item: any): Boolean {
  return item && typeof item === 'object' && !Array.isArray(item);
}

function mergeDeep(target: any, source: any): any {
  let output = Object.assign({}, target);
  if (isObject(target) && isObject(source)) {
    Object.keys(source).forEach(key => {
      if (isObject(source[key])) {
        if (!(key in target)) {
          Object.assign(output, { [key]: source[key] });
        } else {
          output[key] = mergeDeep(target[key], source[key]);
        }
      } else {
        Object.assign(output, { [key]: source[key] });
      }
    });
  }
  return output;
}

function parseFragmentToInlineFragment(
  definitions: string,
): InlineFragmentNode {
  const document = parse(definitions);
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      return {
        kind: Kind.INLINE_FRAGMENT,
        typeCondition: definition.typeCondition,
        selectionSet: definition.selectionSet,
      };
    }
  }
  throw new Error('Could not parse fragment');
}

function addTypeCandidate(
  typeCandidates: { [name: string]: Array<MergeTypeCandidate> },
  name: string,
  typeCandidate: MergeTypeCandidate,
) {
  if (!typeCandidates[name]) {
    typeCandidates[name] = [];
  }
  typeCandidates[name].push(typeCandidate);
}

const defaultVisitType: VisitType = (
  name: string,
  candidates: Array<MergeTypeCandidate>,
) => {
  const resolveType = createResolveType((_, type) => type);
  if (name === 'Query' || name === 'Mutation' || name === 'Subscription') {
    let fields = {};
    let operationName: 'query' | 'mutation' | 'subscription';
    switch (name) {
      case 'Query':
        operationName = 'query';
        break;
      case 'Mutation':
        operationName = 'mutation';
        break;
      case 'Subscription':
        operationName = 'subscription';
        break;
      default:
        break;
    }
    const resolvers = {};
    candidates.forEach(({ type: candidateType, schemaName }) => {
      const candidateFields = (candidateType as GraphQLObjectType).getFields();
      fields = { ...fields, ...candidateFields };
      Object.keys(candidateFields).forEach(fieldName => {
        if (name === 'Subscription') {
          resolvers[fieldName] = {
            subscribe: candidateFields[fieldName].subscribe,
          };
        } else {
          resolvers[fieldName] = createDelegatingResolver(
            schemaName,
            operationName,
            fieldName,
          );
        }
      });
    });
    const type = new GraphQLObjectType({
      name,
      fields: fieldMapToFieldConfigMap(fields, resolveType),
    });
    return {
      type,
      resolvers,
    };
  } else {
    return candidates[candidates.length - 1].type;
  }
};
