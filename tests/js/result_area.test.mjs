import assert from 'node:assert/strict';
import test from 'node:test';

import ResultArea from '../../web_ui/js/components/ResultArea.js';
import mongodbProvider from '../../web_ui/js/sources/mongodb.js';
import redisProvider from '../../web_ui/js/sources/redis.js';


test('copy row INSERT uses MySQL identifier quoting', () => {
    let copiedSql = '';
    const context = {
        rowContextMenu: { row: { id: 1, tenant_id: 8 } },
        queryResult: { providerId: 'mysql' },
        editableInfo: { table: 'asset_basic_info' },
        rowToSourceData() { return { id: 1, tenant_id: 8 }; },
        currentTableName: ResultArea.methods.currentTableName,
        sqlIdentifier: ResultArea.methods.sqlIdentifier,
        sqlLiteral: ResultArea.methods.sqlLiteral,
        redisArgument: ResultArea.methods.redisArgument,
        closeRowContextMenu() {},
        $emit(event, value) {
            if (event === 'copy') copiedSql = value;
        },
    };

    ResultArea.methods.copyRowInsert.call(context);

    assert.equal(
        copiedSql,
        'INSERT INTO `asset_basic_info` (`id`, `tenant_id`) VALUES (1, 8);',
    );
});


test('copying a Redis GET result produces a SET command', () => {
    let copiedCommand = '';
    const key = '2733299010872876842_expireAccountId';
    const value = '\u00002733299010872876841';
    const context = {
        rowContextMenu: { row: [key, value] },
        queryResult: { providerId: 'redis' },
        displayColumns: ['key', 'value'],
        editableInfo: { table: '' },
        rowToSourceData() { return { key, value }; },
        currentTableName: ResultArea.methods.currentTableName,
        sqlIdentifier: ResultArea.methods.sqlIdentifier,
        sqlLiteral: ResultArea.methods.sqlLiteral,
        redisArgument: ResultArea.methods.redisArgument,
        closeRowContextMenu() {},
        $emit(event, value) {
            if (event === 'copy') copiedCommand = value;
        },
    };

    ResultArea.methods.copyRowInsert.call(context);

    assert.equal(
        copiedCommand,
        'SET 2733299010872876842_expireAccountId 2733299010872876841',
    );
});


test('Redis tree copy builds SET with the current string value', () => {
    const table = {
        name: '2733299010872876842_expireAccountId',
        columns: [{ name: 'type', type: 'string' }],
    };

    assert.equal(redisProvider.copyInsertLabel(table), 'Copy SET');
    assert.equal(
        redisProvider.buildInsertQuery(table, '\u00002733299010872876841'),
        'SET 2733299010872876842_expireAccountId 2733299010872876841',
    );
});


test('copying a MongoDB result produces insertOne for the current document', () => {
    let copiedCommand = '';
    const document = { _id: '507f1f77bcf86cd799439011', name: 'Ada' };
    const context = {
        rowContextMenu: { row: [document._id, document.name] },
        queryResult: { providerId: 'mongodb' },
        editableInfo: { table: 'users' },
        rowToSourceData() { return document; },
        currentTableName: ResultArea.methods.currentTableName,
        sqlIdentifier: ResultArea.methods.sqlIdentifier,
        sqlLiteral: ResultArea.methods.sqlLiteral,
        closeRowContextMenu() {},
        $emit(event, value) {
            if (event === 'copy') copiedCommand = value;
        },
    };

    ResultArea.methods.copyRowInsert.call(context);

    assert.equal(
        copiedCommand,
        'db.getCollection("users").insertOne({"_id":"507f1f77bcf86cd799439011","name":"Ada"})',
    );
});


test('MongoDB tree copy uses escaped collection names and current documents', () => {
    const table = { name: 'audit"events' };
    const document = { name: 'Ada', active: true };

    assert.equal(mongodbProvider.copyInsertLabel(table), 'Copy insertOne');
    assert.equal(
        mongodbProvider.buildInsertQuery(table, document),
        'db.getCollection("audit\\"events").insertOne({"name":"Ada","active":true})',
    );
});
