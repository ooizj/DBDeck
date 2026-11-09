// Element Plus locale for <el-config-provider>. The vendored UMD build only ships English, so the
// Chinese strings for the Element Plus components DBDeck uses are provided here (values follow the
// official element-plus/es/locale/lang/zh-cn). English uses the built-in default (null).
const zhCn = {
    name: 'zh-cn',
    el: {
        dialog: { close: '关闭此对话框' },
        drawer: { close: '关闭此对话框' },
        dropdown: { toggleDropdown: '切换下拉选项' },
        inputNumber: { decrease: '减少数值', increase: '增加数值' },
        messagebox: { title: '提示', confirm: '确定', cancel: '取消', error: '输入的数据不合法!', close: '关闭此对话框' },
        popconfirm: { confirmButtonText: '确定', cancelButtonText: '取消' },
        select: { loading: '加载中', noMatch: '无匹配数据', noData: '无数据', placeholder: '请选择' },
        tag: { close: '关闭此标签' },
        table: {
            emptyText: '暂无数据',
            confirmFilter: '筛选',
            resetFilter: '重置',
            clearFilter: '全部',
            sumText: '合计',
            selectAllLabel: '选择所有行',
            selectRowLabel: '选择当前行',
            expandRowLabel: '展开当前行',
            collapseRowLabel: '收起当前行',
            sortLabel: '按 {column} 排序',
            filterLabel: '按 {column} 过滤',
        },
        tree: { emptyText: '暂无数据' },
        image: { error: '加载失败' },
    },
};

export function elementPlusLocale(locale) {
    return locale === 'zh' ? zhCn : null;
}
