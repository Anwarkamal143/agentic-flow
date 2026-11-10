import { tailLines } from '@factory/domain';
import { describe, expect, it } from 'vitest';

describe('tailLines: the last lines of a running process output', () => {
  it('keeps the last `max` lines and says earlier ones were left out', () => {
    expect(tailLines('a\nb\nc\nd\n', { max: 2, fromStart: true })).toEqual({
      lines: ['c', 'd'],
      truncated: true,
    });
  });

  it('keeps everything when it fits', () => {
    expect(tailLines('a\nb\n', { max: 5, fromStart: true })).toEqual({
      lines: ['a', 'b'],
      truncated: false,
    });
  });

  it('keeps a last line still being written', () => {
    expect(tailLines('a\nhalf', { max: 5, fromStart: true }).lines).toEqual(['a', 'half']);
  });

  it('drops the first line of a chunk cut from the middle of the output: it is partial', () => {
    expect(tailLines('rtial\nb\nc\n', { max: 5, fromStart: false })).toEqual({
      lines: ['b', 'c'],
      truncated: true,
    });
  });

  it('has no lines for no output', () => {
    expect(tailLines('', { max: 5, fromStart: true })).toEqual({ lines: [], truncated: false });
  });

  it('treats CRLF like LF', () => {
    expect(tailLines('a\r\nb\r\n', { max: 5, fromStart: true }).lines).toEqual(['a', 'b']);
  });
});
