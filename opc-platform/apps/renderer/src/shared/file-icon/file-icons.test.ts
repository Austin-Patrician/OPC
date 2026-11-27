import { describe, expect, it } from 'vitest';
import * as icons from './file-icon-data';
import { getFileIcon, getFileIconForPath } from './file-icons';

describe('getFileIcon and getFileIconForPath', () => {
  it('maps image formats (including uppercase Windows paths) to image icon and SVG to svg icon', () => {
    for (const sample of [
      'output/whale_girl.png',
      'assets/preview.jpg',
      'assets/frame.jpeg',
      'assets/cover.webp',
      'assets/anim.gif',
      'assets/scan.bmp',
      'assets/hero.avif',
      'OUTPUT\\SLIDE_1.PNG',
    ]) {
      expect(getFileIconForPath(sample), sample).toBe(icons.icon_image);
    }
    expect(getFileIconForPath('slides/slide_01.svg')).toBe(icons.icon_svg);
  });

  it('maps office, media, code, archive, and fallback file types accurately', () => {
    expect(getFileIconForPath('resume.pdf')).toBe(icons.icon_pdf);
    expect(getFileIconForPath('contract.docx')).toBe(icons.icon_word);
    expect(getFileIconForPath('legacy.doc')).toBe(icons.icon_word);
    expect(getFileIconForPath('deck.pptx')).toBe(icons.icon_powerpoint);
    expect(getFileIconForPath('deck.ppt')).toBe(icons.icon_powerpoint);
    expect(getFileIconForPath('metrics.xlsx')).toBe(icons.icon_table);
    expect(getFileIconForPath('metrics.xls')).toBe(icons.icon_table);
    expect(getFileIconForPath('metrics.csv')).toBe(icons.icon_table);

    expect(getFileIconForPath('demo.mp4')).toBe(icons.icon_video);
    expect(getFileIconForPath('demo.mov')).toBe(icons.icon_video);
    expect(getFileIconForPath('voice.mp3')).toBe(icons.icon_audio);
    expect(getFileIconForPath('voice.m4a')).toBe(icons.icon_audio);
    expect(getFileIconForPath('voice.wav')).toBe(icons.icon_audio);

    expect(getFileIconForPath('bundle.zip')).toBe(icons.icon_zip);
    expect(getFileIconForPath('archive.tar')).toBe(icons.icon_zip);
    expect(getFileIconForPath('archive.gz')).toBe(icons.icon_zip);

    expect(getFileIconForPath('NOTES.md')).toBe(icons.icon_markdown);
    expect(getFileIconForPath('config.json')).toBe(icons.icon_json);
    expect(getFileIconForPath('build.py')).toBe(icons.icon_python);
    expect(getFileIconForPath('App.tsx')).toBe(icons.icon_typescript);
    expect(getFileIcon('.png')).toBe(icons.icon_image);
    expect(getFileIconForPath('artifact.unknownext')).toBe(icons.icon_file);
  });
});
