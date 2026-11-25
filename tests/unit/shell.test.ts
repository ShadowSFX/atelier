import { describe, expect, it } from 'vitest';
import { isLocalOscHost, parseOsc7, posixQuote, quotePath, quotePaths, shellPathToNative, toGitBashPath, toWslPath } from '@shared/shell';

describe('path conversion', () => {
  it('converts Windows paths to Git Bash form', () => {
    expect(toGitBashPath('C:\\Users\\me\\My Project')).toBe('/c/Users/me/My Project');
    expect(toGitBashPath('D:\\')).toBe('/d');
    expect(toGitBashPath('\\\\srv\\share\\x')).toBe('//srv/share/x');
  });

  it('converts Windows paths to WSL form', () => {
    expect(toWslPath('C:\\Users\\me')).toBe('/mnt/c/Users/me');
    expect(toWslPath('\\\\wsl.localhost\\Ubuntu\\home\\me', 'Ubuntu')).toBe('/home/me');
    expect(toWslPath('\\\\wsl$\\Ubuntu\\home\\me', 'ubuntu')).toBe('/home/me');
    expect(toWslPath('\\\\wsl.localhost\\Debian\\home\\me', 'Ubuntu')).toBeNull();
    expect(toWslPath('\\\\srv\\share')).toBeNull();
  });

  it('maps shell-reported directories back to native paths', () => {
    expect(shellPathToNative('/C:/Users/me', 'powershell', 'win32')).toBe('C:\\Users\\me');
    expect(shellPathToNative('C:\\Users\\me', 'cmd', 'win32')).toBe('C:\\Users\\me');
    expect(shellPathToNative('/c/Users/me/x y', 'gitbash', 'win32')).toBe('C:\\Users\\me\\x y');
    expect(shellPathToNative('/mnt/d/work', 'wsl', 'win32', 'Ubuntu')).toBe('D:\\work');
    expect(shellPathToNative('/home/me', 'wsl', 'win32', 'Ubuntu')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me');
    expect(shellPathToNative('//srv/share/x', 'powershell', 'win32')).toBe('\\\\srv\\share\\x');
    expect(shellPathToNative('/home/me', 'bash', 'linux')).toBe('/home/me');
  });
});

describe('OSC 7', () => {
  it('decodes percent-encoded paths and keeps the host', () => {
    expect(parseOsc7('file://PC/C:/Users/me/a%20b%23c%25')).toEqual({ host: 'PC', path: '/C:/Users/me/a b#c%' });
    expect(parseOsc7('file://host//srv/share/x')).toEqual({ host: 'host', path: '//srv/share/x' });
  });

  it('tolerates an unencoded percent', () => {
    expect(parseOsc7('file://h/tmp/100%')?.path).toBe('/tmp/100%');
  });

  it('rejects anything that is not a file URL', () => {
    expect(parseOsc7('http://x/y')).toBeNull();
    expect(parseOsc7('garbage')).toBeNull();
  });

  it('accepts only this machine as host', () => {
    expect(isLocalOscHost('', 'PC')).toBe(true);
    expect(isLocalOscHost('localhost', 'PC')).toBe(true);
    expect(isLocalOscHost('pc', 'PC')).toBe(true);
    expect(isLocalOscHost('pc.lan', 'PC')).toBe(true);
    expect(isLocalOscHost('my-vps', 'PC')).toBe(false);
  });
});

describe('quoting pasted paths', () => {
  it('leaves simple paths alone', () => {
    expect(quotePath('C:\\work\\file.txt', 'powershell')).toBe('C:\\work\\file.txt');
    expect(quotePath('/home/me/f.txt', 'bash')).toBe('/home/me/f.txt');
  });

  it('quotes PowerShell paths, doubling single and typographic quotes', () => {
    expect(quotePath("C:\\it's here", 'powershell')).toBe("'C:\\it''s here'");
    expect(quotePath('C:\\a\u2019b c', 'powershell')).toBe("'C:\\a\u2019\u2019b c'");
    expect(quotePath('C:\\$env & more', 'powershell')).toBe("'C:\\$env & more'");
  });

  it('quotes cmd paths with double quotes', () => {
    expect(quotePath('C:\\Program Files\\x', 'cmd')).toBe('"C:\\Program Files\\x"');
  });

  it('converts and quotes for Git Bash and WSL', () => {
    expect(quotePath('C:\\My Files\\a.txt', 'gitbash')).toBe("'/c/My Files/a.txt'");
    expect(quotePath('C:\\data\\a.txt', 'wsl', 'Ubuntu')).toBe('/mnt/c/data/a.txt');
    expect(quotePath('\\\\srv\\share\\x', 'wsl')).toBe("'\\\\srv\\share\\x'");
  });

  it("escapes single quotes for POSIX shells", () => {
    expect(posixQuote("it's")).toBe("'it'\\''s'");
    expect(posixQuote('$(rm -rf ~)')).toBe("'$(rm -rf ~)'");
  });

  it('joins several paths with spaces', () => {
    expect(quotePaths(['C:\\a', 'C:\\b c'], 'powershell')).toBe("C:\\a 'C:\\b c'");
  });
});
