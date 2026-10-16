export default {
    props: ['currentSource', 'editorHeight', 'disabled', 'canExplain'],
    emits: ['execute', 'format', 'explain'],
    data() {
        return {
            showRedisCommands: false,
            redisCommandGroups: [
                { title: 'String', commands: ['GET key', 'SET key value', 'MGET key1 key2', 'INCR counter', 'EXPIRE key 60'] },
                { title: 'Hash', commands: ['HGETALL key', 'HGET key field', 'HSET key field value', 'HDEL key field'] },
                { title: 'List', commands: ['LRANGE key 0 -1', 'LPUSH key value', 'RPUSH key value', 'LPOP key', 'RPOP key'] },
                { title: 'Set', commands: ['SMEMBERS key', 'SADD key member', 'SREM key member', 'SISMEMBER key member'] },
                { title: 'ZSet', commands: ['ZRANGE key 0 -1 WITHSCORES', 'ZADD key 1 member', 'ZREM key member', 'ZREVRANGE key 0 9 WITHSCORES'] },
                { title: 'Stream', commands: ['XRANGE key - +', 'XADD key * field value', 'XLEN key', 'XREAD COUNT 10 STREAMS key 0'] },
                { title: 'Key/DB', commands: ['SCAN 0 MATCH pattern:* COUNT 100', 'KEYS pattern:*', 'TYPE key', 'TTL key', 'DEL key', 'DBSIZE'] },
            ],
        };
    },
    computed: {
        isRedis() {
            return this.currentSource?.db_type === 'redis';
        },
        runShortcut() {
            const platform = navigator.userAgentData?.platform || navigator.platform || '';
            return /mac/i.test(platform) ? '⌘+Enter' : 'Ctrl+Enter';
        },
    },
    watch: {
        currentSource() {
            this.showRedisCommands = false;
        },
    },
    methods: {
        copyCommand(command) {
            navigator.clipboard?.writeText(command);
        },
    },
    template: `
        <div class="editor-area" :style="{ height: editorHeight + 'px' }">
            <div class="toolbar">
                <el-button @click="$emit('execute')" :disabled="disabled || !currentSource" :title="'运行选中语句或当前语句（' + runShortcut + '）'">▶ 运行（{{ runShortcut }}）</el-button>
                <el-button @click="$emit('format')" :disabled="disabled" title="格式化 SQL">⟳ 格式化</el-button>
                <el-button v-if="canExplain" @click="$emit('explain')" :disabled="disabled" title="分析选中语句或当前语句的执行计划">⌗ 执行计划</el-button>
                <el-button v-if="isRedis" @click="showRedisCommands = !showRedisCommands" :disabled="disabled" title="查看 Redis 常用命令">命令参考</el-button>
                <span class="editor-toolbar-context muted" v-if="disabled">数据库加载中，SQL 暂时只读</span>
                <span class="editor-toolbar-context" v-else-if="currentSource">{{ currentSource.database }}</span>
                <span class="editor-toolbar-context muted" v-else>未选择连接</span>
            </div>
            <div v-if="isRedis && showRedisCommands" class="redis-command-help">
                <div v-for="group in redisCommandGroups" :key="group.title" class="redis-command-group">
                    <div class="redis-command-title">{{ group.title }}</div>
                    <button
                        v-for="command in group.commands"
                        :key="command"
                        class="redis-command-chip"
                        @click="copyCommand(command)"
                        :title="'复制: ' + command">
                        {{ command }}
                    </button>
                </div>
            </div>
            <div class="sql-editor-container">
                <div id="monaco-editor" class="sql-editor-view"></div>
            </div>
        </div>
    `
};
