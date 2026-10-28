import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CapacityBar, Columns, Donut, Gauge, RankedBars, StackedBar, Trend, toneForRatio } from './index';

/**
 * The chart components, rendered to static markup.
 *
 * No DOM and no snapshot files: these assert the things a picture can get wrong — the
 * tone a ratio deserves, that an empty series draws an empty track instead of a broken
 * path, that a 100% donut is still a full ring, and that every chart carries a label a
 * screen reader can read.
 */

const markup = (element: React.ReactElement) => renderToStaticMarkup(element);

describe('toneForRatio', () => {
  it('matches the budget states it mirrors', () => {
    expect(toneForRatio(0)).toBe('accent');
    expect(toneForRatio(0.79)).toBe('accent');
    expect(toneForRatio(0.8)).toBe('warning');
    expect(toneForRatio(0.99)).toBe('warning');
    expect(toneForRatio(1)).toBe('danger');
    expect(toneForRatio(3)).toBe('danger');
  });
});

describe('Gauge', () => {
  it('draws a track, a filled arc and the value', () => {
    const html = markup(<Gauge ratio={0.42} label="员工" value="42%" />);

    // Track + fill.
    expect(html.match(/<path/g)).toHaveLength(2);
    expect(html).toContain('var(--accent)');
    expect(html).toContain('42%');
    // A picture without a label is decoration.
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="员工: 42%"');
  });

  it('leaves the arc empty at zero instead of drawing a dot', () => {
    const html = markup(<Gauge ratio={0} label="员工" value="0%" />);
    expect(html.match(/<path/g)).toHaveLength(1);
  });

  it('clamps the arc but keeps the real number in the text', () => {
    const html = markup(<Gauge ratio={2.5} label="项目" value="250%" />);
    expect(html).toContain('250%');
    // One track, one fill — never two fills for an over-run.
    expect(html.match(/<path/g)).toHaveLength(2);
  });

  it('turns red past the hard stop', () => {
    const html = markup(<Gauge ratio={1.1} label="项目" value="110%" />);
    expect(html).toContain('var(--danger)');
  });
});

describe('Donut', () => {
  it('writes the share of every slice next to its label', () => {
    const html = markup(
      <Donut
        emptyLabel="没有数据"
        slices={[
          { key: 'a', label: '员工', value: 3, color: 'red' },
          { key: 'b', label: '项目', value: 1, color: 'blue' },
        ]}
      />,
    );

    expect(html).toContain('75%');
    expect(html).toContain('25%');
    expect(html).toContain('员工');
  });

  it('draws a full ring for a single 100% slice', () => {
    const html = markup(
      <Donut emptyLabel="没有数据" slices={[{ key: 'a', label: '公司', value: 5, color: 'red' }]} />,
    );
    // Four arcs: two for the outer ring, two for the inner cut-out.
    expect(html.match(/A /g)).toHaveLength(4);
  });

  it('falls back to the empty track and the empty label at zero', () => {
    const html = markup(<Donut emptyLabel="没有数据" slices={[{ key: 'a', label: 'x', value: 0, color: 'red' }]} />);
    expect(html).toContain('没有数据');
    // The placeholder ring, not a slice.
    expect(html).toContain('<circle');
  });
});

describe('Trend', () => {
  const points = [
    { label: '10-01', value: 5, reference: 5 },
    { label: '10-02', value: 3, reference: 2.5 },
    { label: '10-03', value: 1, reference: 0 },
  ];

  it('draws the reference line only when one was given', () => {
    const withRef = markup(<Trend points={points} ariaLabel="燃尽" />);
    expect(withRef).toContain('stroke-dasharray="3 3"');

    const withoutRef = markup(
      <Trend points={points.map(({ label, value }) => ({ label, value }))} ariaLabel="燃尽" />,
    );
    expect(withoutRef).not.toContain('stroke-dasharray');
  });

  it('labels itself and both ends of the axis', () => {
    const html = markup(<Trend points={points} ariaLabel="燃尽" valueFormat={(value) => `${value} 项`} />);
    expect(html).toContain('aria-label="燃尽"');
    expect(html).toContain('10-01');
    expect(html).toContain('10-03');
  });

  it('survives an empty series without emitting a broken path', () => {
    const html = markup(<Trend points={[]} ariaLabel="燃尽" />);
    expect(html).not.toContain('d=" L');
    expect(html).toContain('aria-label="燃尽"');
  });
});

describe('Columns', () => {
  it('gives a zero day no bar and a real day a height', () => {
    const html = markup(
      <Columns
        ariaLabel="花费"
        points={[
          { label: '10-01', value: 0 },
          { label: '10-02', value: 2 },
        ]}
        valueFormat={(value) => `$${value}`}
      />,
    );
    expect(html).toContain('height:0%');
    expect(html).toContain('height:100%');
    expect(html).toContain('$2');
  });
});

describe('RankedBars', () => {
  it('prints the formatted value, not a rounded bar length', () => {
    const html = markup(
      <RankedBars
        ariaLabel="成本中心"
        emptyLabel="没有数据"
        formatValue={(value) => `$${value.toFixed(2)}`}
        rows={[
          { key: 'a', label: '工程部', value: 12.5 },
          { key: 'b', label: '市场部', value: 2.5 },
        ]}
      />,
    );
    expect(html).toContain('$12.50');
    expect(html).toContain('$2.50');
    // Longest bar is full width, the other is proportional.
    expect(html).toContain('width:100%');
    expect(html).toContain('width:20%');
  });

  it('says so when there is nothing to rank', () => {
    expect(markup(<RankedBars ariaLabel="成本中心" emptyLabel="没有数据" rows={[]} />)).toContain('没有数据');
  });
});

describe('StackedBar', () => {
  it('sizes each part by its share and skips empty parts', () => {
    const html = markup(
      <StackedBar
        ariaLabel="李雷"
        segments={[
          { key: 'doing', label: '进行中', value: 2, color: 'blue' },
          { key: 'waiting', label: '待审', value: 0, color: 'orange' },
          { key: 'done', label: '已交付', value: 6, color: 'green' },
        ]}
      />,
    );
    // Zero is skipped rather than drawn as a hairline.
    expect(html.match(/flex-grow/g) ?? []).toHaveLength(2);
    expect(html).toContain('flex-grow:2');
    expect(html).toContain('flex-grow:6');
    // The label spells out the numbers for a screen reader.
    expect(html).toContain('李雷（进行中 2，已交付 6）');
  });

  it('draws an empty track when there is nothing to show', () => {
    const html = markup(
      <StackedBar ariaLabel="空" segments={[{ key: 'a', label: 'x', value: 0, color: 'red' }]} />,
    );
    expect(html).not.toContain('flex-grow');
  });
});

describe('CapacityBar', () => {
  it('draws one seat per head, filled and empty', () => {
    const html = markup(<CapacityBar filled={2} total={5} ariaLabel="2/5" />);
    const seats = html.match(/rounded-\[1px\]/g) ?? [];
    expect(seats).toHaveLength(5);
    expect(html).toContain('var(--accent)');
    expect(html).toContain('var(--border-strong)');
  });

  it('switches to a proportional bar when there are too many seats to count', () => {
    const html = markup(<CapacityBar filled={30} total={60} ariaLabel="30/60" />);
    expect(html).not.toContain('rounded-[1px]');
    expect(html).toContain('width:50%');
  });

  it('shows an over-establishment department in danger', () => {
    const html = markup(<CapacityBar filled={9} total={8} ariaLabel="9/8" />);
    expect(html).toContain('var(--danger)');
  });
});
