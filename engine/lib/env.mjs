import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expandTemplate } from './util.mjs';

export function realOs() {
  return process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
}

const normArch = (a) => (a === 'ia32' ? 'x86' : a);

/** Locate an executable on PATH (honours PATHEXT on Windows). Returns a full path or null. */
export function findExecutable(cmd, env) {
  const vars = env.vars;
  const isWin = env.os === 'windows';
  const exts = isWin ? (vars.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const direct = /[\\/]/.test(cmd);
  const dirs = direct ? [''] : (vars.PATH || vars.Path || '').split(isWin ? ';' : ':').filter(Boolean);
  const hasExt = isWin && /\.[A-Za-z0-9]{1,4}$/.test(cmd);
  for (const d of dirs) {
    const base = direct ? cmd : env.pathMod.join(d, cmd);
    const cands = hasExt || !isWin ? [base] : exts.map((e) => base + e);
    for (const c of cands) {
      try {
        if (!fs.statSync(c).isFile()) continue;
        if (!isWin) fs.accessSync(c, fs.constants.X_OK);
        return c;
      } catch {
        /* try next candidate */
      }
    }
  }
  return null;
}

/**
 * Describe the machine. Everything path-related goes through this object so that
 * plans can be computed for another OS (KIT_OS / --os) without touching the real disk layout.
 */
export function getEnv(o = {}) {
  const vars = o.envVars || process.env;
  const real = realOs();
  const osName = o.os || vars.KIT_OS || real;
  const same = osName === real;
  const pm = osName === 'windows' ? path.win32 : path.posix;
  const home = o.home || vars.KIT_HOME_DIR || os.homedir();
  const xdgConfig = (same && vars.XDG_CONFIG_HOME) || pm.join(home, '.config');
  const xdgData = (same && vars.XDG_DATA_HOME) || pm.join(home, '.local', 'share');
  const appdata = osName === 'windows' ? (same && vars.APPDATA) || pm.join(home, 'AppData', 'Roaming') : null;
  const localappdata = osName === 'windows' ? (same && vars.LOCALAPPDATA) || pm.join(home, 'AppData', 'Local') : null;
  const appsupport = osName === 'windows' ? appdata : osName === 'macos' ? pm.join(home, 'Library', 'Application Support') : xdgConfig;
  let wsl = false;
  if (osName === 'linux' && same) {
    try {
      wsl = !!vars.WSL_DISTRO_NAME || /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
    } catch {
      wsl = false;
    }
  }
  const env = {
    os: osName,
    realOs: real,
    isReal: same,
    arch: normArch(o.arch || process.arch),
    wsl,
    home,
    appdata,
    localappdata,
    appsupport,
    xdgConfig,
    xdgData,
    tmp: o.tmp || vars.KIT_TMP_DIR || os.tmpdir(),
    pathMod: pm,
    vars,
    stateDir: o.stateDir || vars.KIT_STATE_DIR || pm.join(home, '.agent-kit'),
    shell: osName === 'windows' ? vars.ComSpec || 'cmd.exe' : vars.SHELL || '/bin/sh',
  };
  env.find = o.find || ((c) => findExecutable(c, env));
  return env;
}

/** Token resolver shared by detection and planning. `extra` adds/overrides tokens (e.g. project). */
export function tokenResolver(env, extra = {}) {
  const self = (inner) => {
    if (Object.prototype.hasOwnProperty.call(extra, inner)) return extra[inner];
    switch (inner) {
      case 'home': return env.home;
      case 'tmp': return env.tmp;
      case 'os': return env.os;
      case 'arch': return env.arch;
      case 'sep': return env.pathMod.sep;
      case 'appdata': return env.appdata ?? env.appsupport;
      case 'localappdata': return env.localappdata ?? env.appsupport;
      case 'appsupport': return env.appsupport;
      case 'xdg_config': return env.xdgConfig;
      case 'xdg_data': return env.xdgData;
      case 'work': return '{work}';
      default: break;
    }
    if (inner.startsWith('env:')) {
      const rest = inner.slice(4);
      const bar = rest.indexOf('|');
      const name = bar < 0 ? rest : rest.slice(0, bar);
      const def = bar < 0 ? '' : rest.slice(bar + 1);
      return env.vars[name] || expandTemplate(def, self);
    }
    return undefined;
  };
  return self;
}

export function expandPath(tpl, env, extra = {}) {
  return env.pathMod.normalize(expandTemplate(tpl, tokenResolver(env, extra)));
}

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

/** Find a command and (optionally) read its version. Only safe command names are executed. */
export function commandInfo(cmd, env, versionArgs = ['--version']) {
  if (!SAFE_NAME.test(cmd)) return { found: false, error: 'unsafe command name' };
  const p = env.find(cmd);
  if (!p) return { found: false };
  if (!env.isReal) return { found: true, path: p, version: null };
  let version = null;
  try {
    const isCmd = env.os === 'windows' && /\.(cmd|bat)$/i.test(p);
    const safeArgs = versionArgs.filter((a) => /^[\w.-]+$/.test(a));
    const r = isCmd
      ? spawnSync(`"${p}" ${safeArgs.join(' ')}`, { shell: true, timeout: 8000, encoding: 'utf8' })
      : spawnSync(p, safeArgs, { timeout: 8000, encoding: 'utf8' });
    const m = /(\d+(?:\.\d+){1,3})/.exec(`${r.stdout || ''} ${r.stderr || ''}`);
    version = m ? m[1] : null;
  } catch {
    /* version unknown */
  }
  return { found: true, path: p, version };
}
