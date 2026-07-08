import { describe, expect, it } from 'vitest';
import { classifyFile, formatBytes } from './attachments';

describe('classifyFile', () => {
  it('classifies images by MIME', () => {
    expect(classifyFile('shot.png', 'image/png')).toBe('image');
    expect(classifyFile('photo.jpg', 'image/jpeg')).toBe('image');
  });

  it('classifies text/config/code files (by MIME or extension)', () => {
    expect(classifyFile('notes.txt', 'text/plain')).toBe('text');
    expect(classifyFile('docker-compose.yml', '')).toBe('text');
    expect(classifyFile('app.py', 'application/octet-stream')).toBe('text');
    expect(classifyFile('nginx.conf', '')).toBe('text');
    // Extensionless well-known name.
    expect(classifyFile('Dockerfile', '')).toBe('text');
  });

  it('rejects unsupported binaries', () => {
    expect(classifyFile('archive.zip', 'application/zip')).toBe('unsupported');
    expect(classifyFile('report.pdf', 'application/pdf')).toBe('unsupported');
  });
});

describe('formatBytes', () => {
  it('formats sizes readably', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(1024 * 1024 * 3)).toBe('3.0 MB');
  });
});
