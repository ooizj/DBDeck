"""从 MySQL 官方手册生成 SQL 补全用的内置函数清单（web_ui/js/utils/mysqlFunctions.js）。

输入（需先下载）：
  --pdf57   https://downloads.mysql.com/docs/refman-5.7-en.a4.pdf 经 `pdftotext -layout` 得到的文本
            （5.7 在线手册已重定向到新版本，只能用 PDF）
  --html    <dir>，内含 ref_8.0.html / ref_8.4.html / ref_9.7.html，
            即 https://dev.mysql.com/doc/refman/<版本>/en/built-in-function-reference.html，
            以及 p8.0/ p8.4/ p9.7/ 下该表链接到的各函数分类页（用于签名和 “added in MySQL x.y.z”）

版本规则：函数从首次出现在手册中的系列起可用（5.7 / 8.0 / 8.4 / 9.x，26.x 手册与 9.7 一致，归入 9.x）；
只有《What Is New in MySQL 8.0》明确列为已移除的函数才在新版本中隐藏，手册表格漏列不视为移除。
"""
import argparse, html, json, re
from pathlib import Path

FAMILIES = ['5.7', '8.0', '8.4', '9.7']
FAMILY_SINCE = {'5.7': '5.7.0', '8.0': '8.0.0', '8.4': '8.4.0', '9.7': '9.0.0'}
# 《What Is New in MySQL 8.0》Features Removed 中明确列出、8.0 起已移除的函数
REMOVED_IN_80 = {
    'PASSWORD', 'ENCODE', 'DECODE', 'ENCRYPT', 'DES_ENCRYPT', 'DES_DECRYPT', 'JSON_APPEND', 'ANALYSE',
    'Area', 'AsBinary', 'AsText', 'AsWKB', 'AsWKT', 'Buffer', 'Centroid', 'Contains', 'ConvexHull', 'Crosses',
    'Dimension', 'Disjoint', 'Distance', 'EndPoint', 'Envelope', 'Equals', 'ExteriorRing', 'GLength',
    'GeomCollFromText', 'GeomCollFromWKB', 'GeomFromText', 'GeomFromWKB', 'GeometryCollectionFromText',
    'GeometryCollectionFromWKB', 'GeometryFromText', 'GeometryFromWKB', 'GeometryN', 'GeometryType',
    'InteriorRingN', 'Intersects', 'IsClosed', 'IsEmpty', 'IsSimple', 'LineFromText', 'LineFromWKB',
    'LineStringFromText', 'LineStringFromWKB', 'MBREqual', 'MLineFromText', 'MLineFromWKB', 'MPointFromText',
    'MPointFromWKB', 'MPolyFromText', 'MPolyFromWKB', 'MultiLineStringFromText', 'MultiLineStringFromWKB',
    'MultiPointFromText', 'MultiPointFromWKB', 'MultiPolygonFromText', 'MultiPolygonFromWKB', 'NumGeometries',
    'NumInteriorRings', 'NumPoints', 'Overlaps', 'PointFromText', 'PointFromWKB', 'PointN', 'PolyFromText',
    'PolyFromWKB', 'PolygonFromText', 'PolygonFromWKB', 'SRID', 'StartPoint', 'Touches', 'Within', 'X', 'Y',
}
# 5.7 手册 JSON 函数一节：未另行说明的 JSON 函数在 5.7.8 加入，以下在 5.7.22 加入
JSON_SINCE_5722 = {'JSON_ARRAYAGG', 'JSON_OBJECTAGG', 'JSON_MERGE_PATCH', 'JSON_MERGE_PRESERVE', 'JSON_PRETTY', 'JSON_STORAGE_SIZE'}

# 手册对其可用补丁版本说法不一（8.4 表格收录，9.7 标注 9.7.4 引入，26.7 未收录），不提示
EXCLUDED = {'VERSION_WITH_UPDATE'}

FUNC_RE = r'[A-Za-z_][A-Za-z0-9_]*'


def clean(fragment):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', '', fragment))).strip()


def parse_reference(path):
    s = path.read_text()
    head = re.findall(r'<th>([^<]*)</th>', s)
    out = {}
    for row in re.findall(r'<tr>(.*?)</tr>', s, re.S):
        th = re.search(r'<th scope="row">(.*?)</th>', row, re.S)
        link = re.search(r'href="([a-z0-9-]+\.html)#([^"]+)"', row)
        tds = [clean(t) for t in re.findall(r'<td>(.*?)</td>', row, re.S)]
        if not th or not tds:
            continue
        cols = dict(zip(head[1:], tds))
        for name in [n.strip() for n in clean(th.group(1)).split(',')]:
            if re.fullmatch(FUNC_RE + r'\(\)', name):
                out.setdefault(name[:-2].upper(), {
                    'name': name[:-2],
                    'desc': cols.get('Description', ''),
                    'deprecated': cols.get('Deprecated') == 'Yes',
                    'page': link.group(1) if link else '',
                    'anchor': link.group(2) if link else '',
                })
    return out


def parse_pages(page_dir):
    """分类页中每个函数锚点后的首段：签名；以及“added in MySQL x.y.z”说明。"""
    info = {}
    for page in page_dir.glob('*.html'):
        s = page.read_text()
        anchors = [(m.start(), m.group(1)) for m in re.finditer(r'name="((?:function|operator)_[^"]+)"', s)]
        for idx, (pos, anchor) in enumerate(anchors):
            section = s[pos:anchors[idx + 1][0] if idx + 1 < len(anchors) else len(s)]
            first_p = re.search(r'<p>(.*?)</p>', section, re.S)
            sigs = []
            if first_p:
                for code in re.findall(r'<code class="literal">(.*?)</code></a>', first_p.group(1), re.S):
                    sig = clean(code)
                    if re.match(FUNC_RE + r'\(', sig):
                        sigs.append(sig)
            text = clean(section)
            since = re.search(r'(?:This function|' + FUNC_RE + r'\(\)) was (?:added|introduced) in MySQL (\d+\.\d+\.\d+)', text)
            info[(page.name, anchor)] = {'sigs': sigs, 'since': since.group(1) if since else ''}
    return info


def parse_57(txt_path):
    lines = txt_path.read_text().split('\n')
    start = next(i for i, l in enumerate(lines) if l.startswith('Table 12.1 Built-In Functions and Operators'))
    end = next(i for i in range(start, len(lines)) if re.match(r'^12\.2 ', lines[i]))
    region = '\n'.join(lines[start:end])
    names = {}
    for name in re.findall(r'\b(' + FUNC_RE + r')\(\)', region):
        names.setdefault(name.upper(), name)
    return names


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pdf57', required=True, type=Path)
    ap.add_argument('--html', required=True, type=Path)
    ap.add_argument('--out', required=True, type=Path)
    args = ap.parse_args()

    families = {v: parse_reference(args.html / f'ref_{v}.html') for v in FAMILIES[1:]}
    pages = {v: parse_pages(args.html / f'p{v}') for v in FAMILIES[1:]}
    names57 = parse_57(args.pdf57)
    removed80 = {n.upper() for n in REMOVED_IN_80}

    entries = {}

    def entry(key, name):
        return entries.setdefault(key, {'name': name, 'sigs': [], 'desc': '', 'since': '', 'until': '', 'deprecated': False})

    for key, name in names57.items():
        if key not in removed80 and key not in families['8.0'] and key not in families['8.4'] and key not in families['9.7']:
            continue
        e = entry(key + ('@57' if key in removed80 else ''), name)
        e['since'] = '5.7.0'
        if key in removed80:
            e['until'] = '8.0.0'
            e['deprecated'] = True
        elif key.startswith('JSON_'):
            e['since'] = '5.7.22' if key in JSON_SINCE_5722 else '5.7.8'

    for family in FAMILIES[1:]:
        for key, ref in families[family].items():
            if key in EXCLUDED:
                continue
            e = entry(key, ref['name'])
            if not e['since']:
                page_info = pages[family].get((ref['page'], ref['anchor']), {})
                since = page_info.get('since', '')
                e['since'] = since if since.startswith(family.split('.')[0] + '.') else FAMILY_SINCE[family]
            # 描述、签名和弃用标记以最新手册为准
            e['name'] = ref['name']
            e['desc'] = ref['desc'] or e['desc']
            e['deprecated'] = ref['deprecated']
            sigs = pages[family].get((ref['page'], ref['anchor']), {}).get('sigs') or []
            sigs = [s for s in sigs if s.split('(')[0].upper() == key] or e['sigs']
            if sigs:
                e['sigs'] = sigs

    rows = []
    for key in sorted(entries, key=lambda k: (entries[k]['name'].upper(), k)):
        e = entries[key]
        rows.append([e['name'], e['sigs'], e['desc'], e['since'], e['until'], 1 if e['deprecated'] else 0])

    body = ',\n'.join('    ' + json.dumps(r, ensure_ascii=False) for r in rows)
    args.out.write_text(
        '// 由 scripts/gen_mysql_functions.py 根据 MySQL 官方参考手册（5.7 / 8.0 / 8.4 / 9.7）生成，请勿手改。\n'
        '// 每项：[name, signatures, description, since, until, deprecated]；since / until 为服务器版本区间 [since, until)。\n'
        'export const MYSQL_FUNCTIONS = [\n' + body + ',\n];\n'
    )
    print(f'{len(rows)} functions -> {args.out}')


if __name__ == '__main__':
    main()
