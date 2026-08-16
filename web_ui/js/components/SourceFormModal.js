import { listProviders, getProvider } from '../sources/registry.js?v=7features-20260610';

export default {
    props: {
        show: Boolean,
        isEditing: Boolean,
        newSource: Object,
        isTesting: Boolean,
        isLoading: Boolean,
        availableDatabases: Array,
        isDiscovering: Boolean,
    },
    emits: ['close', 'test-connection', 'save-source', 'discover-databases'],
    computed: {
        providers() { return listProviders(); },
        currentProvider() {
            return getProvider(this.newSource.type);
        },
        formRows() {
            const fields = this.currentProvider.connFormFields || [];
            return fields;
        },
        connectionFields() {
            return this.formRows.filter((field) => !this.isSshField(field));
        },
        sshToggleField() {
            return this.formRows.find((field) => field.key === 'use_ssh_tunnel');
        },
        sshFields() {
            return this.formRows.filter((field) => this.isSshField(field) && field.key !== 'use_ssh_tunnel');
        },
    },
    methods: {
        isSshField(field) {
            return field.key === 'use_ssh_tunnel' || field.key.startsWith('ssh_');
        },
        fieldVisible(field) {
            if (!field.visibleWhen) return true;
            return this.newSource[field.visibleWhen.key] === field.visibleWhen.value;
        },
        fieldGridClass(field) {
            const wideKeys = ['database', 'ssh_private_key', 'ssh_private_key_passphrase'];
            return wideKeys.includes(field.key) ? 'span-2' : '';
        },
    },
    template: `
        <el-dialog
            :model-value="show"
            @update:model-value="$emit('close')"
            :title="isEditing ? '编辑数据源' : '添加数据源'"
            width="640px"
            destroy-on-close
            append-to-body
        >
            <el-form label-position="top">
                <div class="source-form-section">
                    <div class="source-form-grid">
                        <el-form-item label="类型">
                            <el-select v-model="newSource.type" style="width: 100%;">
                                <el-option v-for="p in providers" :key="p.id" :label="p.displayName" :value="p.id" />
                            </el-select>
                        </el-form-item>
                        <el-form-item label="名称">
                            <template #label>名称 <span style="color: #ff4d4f;">*</span></template>
                            <el-input v-model="newSource.name" placeholder="例如: 生产环境 / 本地文件" />
                        </el-form-item>
                    </div>
                </div>

                <div class="source-form-section">
                    <div class="section-title">连接信息</div>
                    <div class="source-form-grid">
                        <template v-for="field in connectionFields" :key="field.key">
                            <el-form-item
                                v-if="fieldVisible(field) && field.type === 'database-discover'"
                                :class="fieldGridClass(field)"
                            >
                                <template #label>
                                    {{ field.label }}
                                    <a v-if="newSource.host" href="#" @click.prevent="$emit('discover-databases')" class="inline-link">获取列表</a>
                                </template>
                                <div style="position: relative; width: 100%;">
                                    <el-input
                                        :type="newSource.type === 'redis' && field.key === 'database' ? 'number' : 'text'"
                                        v-model="newSource[field.key]"
                                        :placeholder="field.placeholder" />
                                    <div v-if="availableDatabases && availableDatabases.length > 0" class="db-suggestions">
                                        <div v-for="db in availableDatabases" :key="db"
                                             class="db-tag" @click="newSource[field.key] = db">
                                            {{ db }}
                                        </div>
                                    </div>
                                </div>
                                <div v-if="isDiscovering" class="field-hint active">正在获取服务器数据库列表...</div>
                                <div v-if="field.hint" class="field-hint">{{ field.hint }}</div>
                            </el-form-item>
                            <el-form-item v-else-if="fieldVisible(field)" :label="field.label" :class="fieldGridClass(field)">
                                <el-input
                                    :type="field.type || 'text'"
                                    v-model="newSource[field.key]"
                                    :placeholder="field.placeholder" />
                                <div v-if="field.hint" class="field-hint">{{ field.hint }}</div>
                            </el-form-item>
                        </template>
                    </div>
                </div>

                <div v-if="sshToggleField" class="source-form-section ssh-section">
                    <el-checkbox v-model="newSource[sshToggleField.key]">{{ sshToggleField.label }}</el-checkbox>
                    <div v-if="sshToggleField.hint" class="field-hint">{{ sshToggleField.hint }}</div>

                    <div v-if="newSource.use_ssh_tunnel" class="source-form-grid ssh-grid">
                        <template v-for="field in sshFields" :key="field.key">
                            <el-form-item v-if="fieldVisible(field)" :label="field.label" :class="fieldGridClass(field)">
                                <el-input
                                    :type="field.type || 'text'"
                                    v-model="newSource[field.key]"
                                    :placeholder="field.placeholder" />
                                <div v-if="field.hint" class="field-hint">{{ field.hint }}</div>
                            </el-form-item>
                        </template>
                    </div>
                </div>
            </el-form>

            <template #footer>
                <el-button style="margin-right: auto;" @click="$emit('test-connection')" :loading="isTesting" :disabled="isLoading">
                    测试连接
                </el-button>
                <el-button @click="$emit('close')" :disabled="isLoading">取消</el-button>
                <el-button type="primary" @click="$emit('save-source')" :loading="isLoading">
                    {{ isLoading ? '保存中...' : '保存' }}
                </el-button>
            </template>
        </el-dialog>
    `,
};
