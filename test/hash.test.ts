import { describe, expect, it } from 'vitest';
import { canonicalJson, hashToolCall } from '../src/core/canonical.js';

describe('canonicalJson', () => {
  it('sorts keys so insertion order cannot change the bytes', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('sorts nested keys too', () => {
    expect(canonicalJson({ x: { d: 1, c: 2 } })).toBe(canonicalJson({ x: { c: 2, d: 1 } }));
  });

  it('preserves array order, which is meaningful', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('drops undefined values rather than emitting invalid JSON', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('handles null and primitives', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson('x')).toBe('"x"');
    expect(canonicalJson(3)).toBe('3');
  });
});

describe('hashToolCall', () => {
  const input = { file_path: '/a.ts', old_string: 'x', new_string: 'y' };

  it('is stable across key reordering — the retry must match the original', () => {
    const reordered = { new_string: 'y', file_path: '/a.ts', old_string: 'x' };
    expect(hashToolCall('Edit', reordered)).toBe(hashToolCall('Edit', input));
  });

  it('changes when the content changes', () => {
    expect(hashToolCall('Edit', { ...input, new_string: 'z' })).not.toBe(
      hashToolCall('Edit', input),
    );
  });

  it('changes when the tool changes', () => {
    expect(hashToolCall('Write', input)).not.toBe(hashToolCall('Edit', input));
  });
});