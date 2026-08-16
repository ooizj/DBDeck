export function mongoCollectionExpression(collection) {
    return `db.getCollection(${JSON.stringify(String(collection))})`;
}

export function buildMongoInsertOneCommand(collection, document) {
    return `${mongoCollectionExpression(collection)}.insertOne(${JSON.stringify(document)})`;
}
