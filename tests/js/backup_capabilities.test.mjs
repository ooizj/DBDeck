import assert from 'node:assert/strict';
import test from 'node:test';

import mongodb from '../../web_ui/js/sources/mongodb.js';
import mysql from '../../web_ui/js/sources/mysql.js';
import postgresql from '../../web_ui/js/sources/postgresql.js';
import redis from '../../web_ui/js/sources/redis.js';
import sqlite from '../../web_ui/js/sources/sqlite.js';


test('backup is offered only for providers with restorable SQL output', () => {
    assert.equal(mysql.capabilities.backup, true);
    assert.equal(postgresql.capabilities.backup, false);
    assert.equal(sqlite.capabilities.backup, true);
    assert.notEqual(mongodb.capabilities.backup, true);
    assert.notEqual(redis.capabilities.backup, true);
});
