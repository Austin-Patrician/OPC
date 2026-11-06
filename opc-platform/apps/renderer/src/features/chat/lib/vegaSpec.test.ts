import { describe, expect, it } from 'vitest';
import { containsExternalVegaDataUrl } from './vegaSpec';

describe('containsExternalVegaDataUrl', () => {
  it.each([
    ['top-level source', { data: { url: 'https://example.com/data.csv' } }],
    ['protocol-relative source', { data: { url: '//example.com/data.csv' } }],
    ['nested layered source', { layer: [{ data: { url: 'http://example.com/data.json' } }] }],
    ['nested facet source', { spec: { data: { values: [] } }, datasets: { sample: { url: 'https://example.com/x' } } }],
  ])('blocks %s', (_name, spec) => {
    expect(containsExternalVegaDataUrl(spec)).toBe(true);
  });

  it('allows inline values and local relative paths', () => {
    expect(containsExternalVegaDataUrl({ data: { values: [{ x: 1 }] } })).toBe(false);
    expect(containsExternalVegaDataUrl({ data: { url: './chart.csv' } })).toBe(false);
  });
});
