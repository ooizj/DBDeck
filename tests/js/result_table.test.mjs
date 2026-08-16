import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import ResultTable from '../../web_ui/js/components/ResultTable.js';

const styles = fs.readFileSync(
    new URL('../../web_ui/css/style.css', import.meta.url),
    'utf8',
);


test('double-clicking an editable NULL cell opens inline editing', () => {
    const context = {
        editable: { enabled: true },
        activeInlineCell: { rowIdx: -1, colIdx: -1 },
        inlineEditValue: 'unchanged',
        getCellValue() { return null; },
        getCellEditValue() { return ''; },
        $nextTick() {},
    };

    ResultTable.methods.showCellDetail.call(context, [null], 'value', 0, 3, 0);

    assert.deepEqual(context.activeInlineCell, { rowIdx: 3, colIdx: 0 });
    assert.equal(context.inlineEditValue, '');
});

test('result table isolates WebKit scrolling and keeps one sticky header layer', () => {
    assert.match(ResultTable.template, /<table class="result-data-table"/);

    const scrollContainerRule = styles.match(/\.table-container\s*\{[^}]*\}/s)?.[0] || '';
    assert.match(scrollContainerRule, /contain:\s*layout paint/);
    assert.match(scrollContainerRule, /will-change:\s*scroll-position/);

    const resultTableRule = styles.match(/\.result-data-table\s*\{[^}]*\}/s)?.[0] || '';
    assert.match(resultTableRule, /border-collapse:\s*separate/);
    assert.match(resultTableRule, /border-spacing:\s*0/);

    const resultHeaderRule = styles.match(/\.result-data-table\s+thead\s*\{[^}]*\}/s)?.[0] || '';
    assert.match(resultHeaderRule, /position:\s*sticky/);

    const resultHeaderCellRule = styles.match(/\.result-data-table\s+th\s*\{[^}]*\}/s)?.[0] || '';
    assert.match(resultHeaderCellRule, /position:\s*relative/);
    assert.match(resultHeaderCellRule, /top:\s*auto/);
});
