import { listProviders, getProvider } from '../sources/registry.js?v=7features-20260610';

// 4 列栅格中各字段占的列数；未列出的字段占满一行
const FIELD_SPANS = {
    host: 3,
    port: 1,
    user: 2,
    password: 2,
    ssh_host: 3,
    ssh_port: 1,
    ssh_user: 2,
    ssh_password: 2,
};

export default {
    props: {
        show: Boolean,
        isEditing: Boolean,
        newSource: Object,
        isTesting: Boolean,
        isLoading: Boolean,
        availableDatabases: Array,
        isDiscovering: Boolean,
        groupNames: { type: Array, default: () => [] },
    },
    emits: ['close', 'test-connection', 'save-source', 'discover-databases'],
    computed: {
        providers() { return listProviders(); },
        currentProvider() {
            return getProvider(this.newSource.type);
        },
        formRows() {
            return this.currentProvider.connFormFields || [];
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
        fieldStyle(field) {
            return { gridColumn: `span ${FIELD_SPANS[field.key] || 4}` };
        },
        inputType(field) {
            if (field.type === 'password') return 'password';
            if (field.type === 'number') return 'number';
            return 'text';
        },
    },
    template: `
        <el-dialog
            :model-value="show"
            @update:model-value="$emit('close')"
            :title="isEditing ? '编辑连接' : '新建连接'"
            width="620px"
            destroy-on-close
            append-to-body
            class="source-form-dialog"
        >
            <el-form label-position="top" class="sf-form" @submit.prevent>
                <el-form-item label="数据库类型" class="sf-type-item">
                    <el-radio-group v-model="newSource.type" size="small" class="sf-type-group">
                        <el-radio-button v-for="p in providers" :key="p.id" :value="p.id">{{ p.displayName }}</el-radio-button>
                    </el-radio-group>
                </el-form-item>

                <div class="sf-grid">
                    <el-form-item style="grid-column: span 2;" required>
                        <template #label>连接名称</template>
                        <el-input v-model="newSource.name" placeholder="例如：生产订单库" />
                    </el-form-item>
                    <el-form-item label="分组" style="grid-column: span 2;">
                        <el-select no-data-text="暂无分组，直接输入名称即可新建"
                            v-model="newSource.group_name"
                            filterable allow-create default-first-option clearable
                            placeholder="不分组，或选择 / 输入分组名">
                            <el-option v-for="name in groupNames" :key="name" :label="name" :value="name" />
                        </el-select>
                    </el-form-item>
                </div>

                <div class="sf-section-title">连接信息</div>
                <div class="sf-grid">
                    <template v-for="field in connectionFields" :key="field.key">
                        <el-form-item v-if="fieldVisible(field) && field.type === 'checkbox'" :style="fieldStyle(field)" class="sf-check-item">
                            <el-checkbox v-model="newSource[field.key]">{{ field.label }}</el-checkbox>
                            <div v-if="field.hint" class="field-hint">{{ field.hint }}</div>
                        </el-form-item>
                        <el-form-item v-else-if="fieldVisible(field) && field.type === 'database-discover'" :label="field.label" :style="fieldStyle(field)">
                            <el-input v-model="newSource[field.key]" :placeholder="field.placeholder">
                                <template #append>
                                    <el-button :loading="isDiscovering" :disabled="!newSource.host" @click="$emit('discover-databases')">获取列表</el-button>
                                </template>
                            </el-input>
                            <div v-if="availableDatabases && availableDatabases.length" class="sf-db-list">
                                <button v-for="db in availableDatabases" :key="db" type="button"
                                        :class="['sf-db-chip', { active: String(newSource[field.key]) === String(db) }]"
                                        @click="newSource[field.key] = db">{{ db }}</button>
                            </div>
                            <div v-if="field.hint" class="field-hint">{{ field.hint }}</div>
                        </el-form-item>
                        <el-form-item v-else-if="fieldVisible(field)" :label="field.label" :style="fieldStyle(field)">
                            <el-input
                                :type="inputType(field)"
                                v-model="newSource[field.key]"
                                :placeholder="field.placeholder != null ? String(field.placeholder) : ''"
                                :show-password="field.type === 'password'" />
                            <div v-if="field.hint" class="field-hint">{{ field.hint }}</div>
                        </el-form-item>
                    </template>
                </div>

                <div v-if="sshToggleField" :class="['sf-ssh', { open: newSource.use_ssh_tunnel }]">
                    <div class="sf-ssh-header">
                        <el-switch v-model="newSource[sshToggleField.key]" size="small" />
                        <span class="sf-ssh-title">通过 SSH 通道连接</span>
                        <span v-if="sshToggleField.hint" class="sf-ssh-hint">{{ sshToggleField.hint }}</span>
                    </div>
                    <div v-if="newSource.use_ssh_tunnel" class="sf-grid sf-ssh-grid">
                        <template v-for="field in sshFields" :key="field.key">
                            <el-form-item v-if="fieldVisible(field)" :label="field.label" :style="fieldStyle(field)">
                                <el-input
                                    :type="inputType(field)"
                                    v-model="newSource[field.key]"
                                    :placeholder="field.placeholder != null ? String(field.placeholder) : ''"
                                    :show-password="field.type === 'password'" />
                                <div v-if="field.hint" class="field-hint">{{ field.hint }}</div>
                            </el-form-item>
                        </template>
                    </div>
                </div>
            </el-form>

            <template #footer>
                <div class="sf-footer">
                    <el-button @click="$emit('test-connection')" :loading="isTesting" :disabled="isLoading">测试连接</el-button>
                    <span class="sf-footer-spacer"></span>
                    <el-button @click="$emit('close')" :disabled="isLoading">取消</el-button>
                    <el-button type="primary" @click="$emit('save-source')" :loading="isLoading">保存</el-button>
                </div>
            </template>
        </el-dialog>
    `,
};
