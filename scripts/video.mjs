#!/usr/bin/env node
// 先检查版本；这段提示不使用新版语法。
if (Number(process.versions.node.split('.')[0]) < 18) {
    process.stderr.write('请先安装 Node.js 18 或更新版本，再运行这个脚本。\n');
    process.exit(1);
}

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import {loadRuntimeConfig} from './runtime-config.mjs';

export const VERSION = '2.0';
export const MODELS = {
    'seedance-2.0': { provider: 'seedance', id: 'doubao-seedance-2-0-260128', images: true },
    'seedance-2.0-fast': { provider: 'seedance', id: 'doubao-seedance-2-0-fast-260128', images: true },
    'seedance-2.0-mini': { provider: 'seedance', id: 'doubao-seedance-2-0-mini-260615', images: false },
    'seedance-2.5': { provider: 'seedance', id: 'doubao-seedance-2-5-260628', images: false },
    'minimax-h3-max': { provider: 'minimax', id: 'MiniMax-H3-Max', images: true },
};
const IMAGE_FORMATS = { seedance: ['image/jpeg', 'image/png'], minimax: ['image/jpeg'] };
const MODEL_NAMES = { 'seedance-2.0': 'Seedance 2.0', 'seedance-2.0-fast': 'Seedance 2.0 Fast',
    'seedance-2.0-mini': 'Seedance 2.0 mini', 'seedance-2.5': 'Seedance 2.5', 'minimax-h3-max': 'MiniMax H3-Max' };
const KEY_VARS = { seedance: 'HEIHUZI_SEEDANCE_API_KEY', minimax: 'HEIHUZI_MINIMAX_API_KEY' };
const GROUPS = { seedance: 'Seedance 视频', minimax: 'MiniMax 视频' };
const validTaskId = value => typeof value === 'string' && /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(value);
export class UserError extends Error {}
export class OutputError extends Error {}
export class NetworkError extends Error {}
export class HTTPError extends NetworkError {
    constructor(code, raw) { super(); this.status = code; this.raw = raw; }
}
export class LocalImage {
    constructor(file, size, provider) { this.path = file; this.size = size; this.provider = provider; }
}
// 保留 Python JSON 的空格、ASCII 转义及字段顺序，包括代理对。
export function json(value, ascii = true, replacer = v => v) {
    const quote = s => {
        const text = JSON.stringify(s);
        return ascii ? text.replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) : text;
    };
    function visit(v) {
        v = replacer(v);
        if (v === null || v === undefined) return 'null';
        if (typeof v === 'string') return quote(v);
        if (typeof v === 'number') return Number.isNaN(v) ? 'NaN' : v === Infinity ? 'Infinity' : v === -Infinity ? '-Infinity' : String(v);
        if (typeof v === 'boolean') return String(v);
        if (Array.isArray(v)) return '[' + v.map(visit).join(', ') + ']';
        return '{' + Object.entries(v).map(([k, x]) => quote(k) + ': ' + visit(x)).join(', ') + '}';
    }
    return visit(value);
}
// 费用沿用 Python 的十进制舍入（恰好一半时取偶数），避免二进制浮点边界差异。
export function fixed(value, digits) {
    const b = Buffer.alloc(8); b.writeDoubleBE(value);
    const bits = b.readBigUInt64BE();
    const negative = (bits >> 63n) !== 0n;
    const exponent = Number((bits >> 52n) & 2047n);
    let numerator = bits & ((1n << 52n) - 1n);
    if (exponent) numerator += 1n << 52n;
    const power = (exponent || 1) - 1023 - 52;
    numerator *= 10n ** BigInt(digits);
    let denominator = 1n;
    if (power >= 0) numerator <<= BigInt(power); else denominator <<= BigInt(-power);
    let rounded = numerator / denominator;
    const remainder = numerator % denominator;
    if (2n * remainder > denominator || (2n * remainder === denominator && rounded % 2n)) rounded++;
    let s = rounded.toString().padStart(digits + 1, '0');
    if (digits) s = s.slice(0, -digits) + '.' + s.slice(-digits);
    return (negative ? '-' : '') + s;
}
export function sniff_image(data) {
    if (data.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'image/jpeg';
    if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
    return null;
}
function writeAll(fd, bytes, filesystem = fs, position = null) {
    let offset = 0;
    while (offset < bytes.length) offset += filesystem.writeSync(fd, bytes, offset, bytes.length - offset, position === null ? null : position + offset);
}
function writeTerminal(stream, text) {
    return new Promise((resolve, reject) => {
        const onError = error => reject(error);
        stream.once('error', onError);
        try {
            stream.write(text, 'utf8', error => {
                // 写入失败时还会触发 error 事件，留着监听器接住它。
                if (error) reject(error);
                else { stream.removeListener('error', onError); resolve(); }
            });
        } catch (error) { stream.removeListener('error', onError); reject(error); }
    });
}
// 使用原生 http/https 的套接字空闲超时；提交请求只发一次，不自动重试。
export function request(url, options, redirects = 0) {
    return new Promise((resolve, reject) => {
        let parsed;
        try { parsed = new URL(url); } catch { reject(new NetworkError()); return; }
        const transport = parsed.protocol === 'https:' ? https : parsed.protocol === 'http:' ? http : null;
        if (!transport) { reject(new NetworkError()); return; }
        const req = transport.request(parsed, { method: options.method || 'GET', headers: { 'User-Agent': `video-gen/${VERSION}`, ...options.headers } }, res => {
            const status = res.statusCode;
            if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
                res.resume();
                if (redirects >= 10 || (['POST', 'PUT'].includes(options.method) && [307, 308].includes(status))) {
                    reject(new HTTPError(status, '')); return;
                }
                let destination;
                try { destination = new URL(res.headers.location, parsed); }
                catch { reject(new NetworkError()); return; }
                const next = { ...options, headers: { ...options.headers } };
                // 端口、协议或主机变化都算跨来源；Header 名称不区分大小写。
                if (destination.origin !== parsed.origin) {
                    for (const name of Object.keys(next.headers)) {
                        if (name.toLowerCase() === 'authorization') delete next.headers[name];
                    }
                }
                if (options.method === 'POST' && [301, 302, 303].includes(status)) {
                    next.method = 'GET'; next.body = null;
                    delete next.headers['Content-Length']; delete next.headers['Content-Type'];
                }
                resolve(request(destination.href, next, redirects + 1));
                return;
            }
            const parts = [];
            let fd;
            try { if (status < 400 && options.target) fd = fs.openSync(options.target, 'w'); }
            catch (error) { res.destroy(); reject(error); return; }
            function close() { if (fd !== undefined) { const current = fd; fd = undefined; fs.closeSync(current); } }
            res.on('data', chunk => {
                try { if (fd === undefined) parts.push(chunk); else writeAll(fd, chunk); }
                catch (error) { try { close(); } catch {} res.destroy(); reject(error); }
            });
            res.on('error', () => { try { close(); } catch {} reject(new NetworkError()); });
            res.on('end', () => {
                try {
                    close();
                    const raw = Buffer.concat(parts);
                    if (status >= 400) reject(new HTTPError(status, raw.toString('utf8')));
                    else resolve(raw);
                } catch (error) { reject(error); }
            });
        });
        req.once('socket', socket => {
            if (!socket.connecting) return;
            // setTimeout 只覆盖已连接的套接字，单独限制建连与 TLS 握手。
            const timer = setTimeout(() => req.destroy(new NetworkError()), options.timeout * 1000);
            const clear = () => clearTimeout(timer);
            socket.once(parsed.protocol === 'https:' ? 'secureConnect' : 'connect', clear);
            req.once('close', clear);
        });
        req.setTimeout(options.timeout * 1000, () => req.destroy(new NetworkError()));
        req.on('error', () => reject(new NetworkError()));
        req.end(options.body || undefined);
    });
}

// 每个运行实例独立，测试可替换边界操作，不需要监听端口或真实 Key。
export function createRuntime(overrides = {}) {
    const {settings, resolvePath} = loadRuntimeConfig(import.meta.url, {api_base_url: 'string', credential_file: 'string'});
    if (!settings.api_base_url.trim() || !settings.credential_file.trim()) throw new Error('服务地址和密钥文件路径不能为空。');
    const r = {
        env: process.env, fs, platform: process.platform, executable: process.execPath,
        script: fileURLToPath(import.meta.url), MAX_REQUEST_BYTES: 95_000_000,
        MAX_IMAGE_BYTES: 30 * 1024 * 1024 - 1,
        request, uuid: () => randomUUID().replace(/-/g, ''),
        monotonic: () => performance.now() / 1000, now: () => Date.now() / 1000,
        sleep: seconds => new Promise(resolve => setTimeout(resolve, Math.max(0, seconds * 1000))),
        stdout: process.stdout, stderr: process.stderr,
        write: (text, stderr = false) => {
            const stream = stderr ? r.stderr : r.stdout;
            return stream.isTTY ? writeTerminal(stream, text) : writeAll(stderr ? 2 : 1, Buffer.from(text, 'utf8'));
        },
        flush: () => {}, configure: () => {},
        ...overrides,
    };
    r.BASE_URL = (r.env.HEIHUZI_BASE_URL ?? settings.api_base_url).replace(/\/+$/, '');
    r.home = () => (r.platform === 'win32' ? r.env.USERPROFILE : r.env.HOME) || os.homedir();
    r.expanduser = value => {
        if (value === '~' || value.startsWith('~/') || (r.platform === 'win32' && value.startsWith('~\\')))
            return path.join(r.home(), value.slice(2));
        return path.normalize(value);
    };
    r.knownKeys = new Set();
    r.write_output = async (text, stderr = false) => {
        for (const key of [...r.knownKeys, ...Object.values(KEY_VARS).map(k => r.env[k]), r.env.HEIHUZI_API_KEY]) {
            if (key) { text = text.split(key).join('<Key>'); text = text.split(json(key).slice(1, -1)).join('<Key>'); }
        }
        try { await r.write(text + '\n', stderr); await r.flush(stderr); } catch { throw new OutputError(); }
    };
    r.warn_output = async text => { try { await r.write_output(text, true); } catch (e) { if (!(e instanceof OutputError)) throw e; } };
    r.emit = obj => {
        let result = json(obj);
        if (typeof obj.cost === 'number' && Number.isInteger(obj.cost)) result = result.replace(/("cost": )(-?\d+)(,|})/, '$1$2.0$3');
        return r.write_output(result);
    };
    r.resolve_model = name => {
        const key = name.trim().toLowerCase();
        if (Object.hasOwn(MODELS, key)) return [key, MODELS[key]];
        for (const [alias, model] of Object.entries(MODELS)) if (model.id.toLowerCase() === key) return [alias, model];
        throw new UserError(`不支持的模型 ${name}，可选：${Object.keys(MODELS).join(', ')}`);
    };
    r.image_url = (value, provider) => {
        value = value.trim();
        if (/^https?:\/\//i.test(value)) return value;
        if (/^file:\/\//i.test(value)) value = value.slice(7);
        const file = r.expanduser(value);
        let stat;
        try { stat = r.fs.statSync(file); } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
        if (!stat?.isFile()) throw new UserError(`找不到图片文件：${value}`);
        if (stat.size > r.MAX_IMAGE_BYTES) throw new UserError(`图片 ${path.basename(file)} 有 ${fixed(stat.size / 1024 / 1024, 1)} MB，要小于 30 MB，请先压缩`);
        return new LocalImage(file, stat.size, provider);
    };
    r.encode_request = body => {
        let images, prefix, template;
        do {
            images = []; prefix = '__heihuzi_image_' + r.uuid() + '_';
            template = json(body, true, value => {
                if (!(value instanceof LocalImage)) return value;
                const marker = prefix + images.length + '__'; images.push([marker, value]); return marker;
            });
        } while (template.split(prefix).length - 1 !== images.length);
        const estimated = template.length + images.reduce((sum, [marker, image]) => sum + 4 * Math.ceil(image.size / 3) + 23 - marker.length, 0);
        if (estimated > r.MAX_REQUEST_BYTES) throw new UserError(`图片合计太大：转码后约 ${fixed(estimated / 1_000_000, 1)} MB，超过便利店单次上传上限（约 95 MB）。请压缩图片、减少张数，或改用图片的公网链接。没有提交，不扣费。`);
        // 一次分配结果，分块编码；块长为 3 的倍数，只有最后一块出现填充符。
        const result = Buffer.allocUnsafe(estimated);
        let written = 0, offset = 0;
        const append = s => { written += result.write(s, written, undefined, 'ascii'); };
        for (const [marker, image] of images) {
            const position = template.indexOf(marker, offset);
            append(template.slice(offset, position));
            const fd = r.fs.openSync(image.path, 'r');
            try {
                if (r.fs.fstatSync(fd).size !== image.size) throw new UserError(`图片 ${path.basename(image.path)} 大小已变化，请重新提交。没有提交，不扣费。`);
                const chunk = Buffer.allocUnsafe(Math.min(image.size + 1, 3 * 16 * 1024));
                let read = 0, first = true;
                while (read < image.size) {
                    const wanted = Math.min(chunk.length, image.size - read);
                    let filled = 0;
                    while (filled < wanted) {
                        const n = r.fs.readSync(fd, chunk, filled, wanted - filled, null);
                        if (!n) break;
                        filled += n;
                    }
                    if (filled !== wanted) throw new UserError(`图片 ${path.basename(image.path)} 大小已变化，请重新提交。没有提交，不扣费。`);
                    if (first) {
                        const mime = sniff_image(chunk.subarray(0, filled));
                        if (!IMAGE_FORMATS[image.provider].includes(mime)) throw new UserError(`图片 ${path.basename(image.path)} 不是 ${IMAGE_FORMATS[image.provider].map(m => m.split('/')[1]).sort().join('、')} 格式，请先转换`);
                        append(`data:${mime};base64,`); first = false;
                    }
                    append(chunk.subarray(0, filled).toString('base64')); read += filled;
                }
                if (r.fs.readSync(fd, chunk, 0, 1, null)) throw new UserError(`图片 ${path.basename(image.path)} 大小已变化，请重新提交。没有提交，不扣费。`);
                if (first) throw new UserError(`图片 ${path.basename(image.path)} 不是 ${IMAGE_FORMATS[image.provider].map(m => m.split('/')[1]).sort().join('、')} 格式，请先转换`);
            } finally { r.fs.closeSync(fd); }
            offset = position + marker.length;
        }
        append(template.slice(offset));
        return result.subarray(0, written);
    };
    r.env_file = () => r.env.HEIHUZI_ENV_FILE ? r.expanduser(r.env.HEIHUZI_ENV_FILE) : resolvePath(settings.credential_file);
    r.read_env_text = file => {
        try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(r.fs.readFileSync(file)); }
        catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
    };
    r.read_env_file = file => {
        const values = Object.create(null);
        for (const raw of r.read_env_text(file).split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/)) {
            const line = raw.trim(), index = line.indexOf('=');
            if (index >= 0 && !line.startsWith('#')) values[line.slice(0, index).trim()] = line.slice(index + 1).trim().replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '');
        }
        return values;
    };
    r.script_command = (...args) => [r.executable || 'node', path.resolve(r.script)].map(p => /\s/.test(p) ? '"' + p + '"' : p).concat(args).join(' ');
    r.api_key = provider => {
        const name = KEY_VARS[provider];
        const key = r.env[name] || r.read_env_file(r.env_file())[name] || r.env.HEIHUZI_API_KEY;
        if (!key) throw new UserError(`还没有设置密钥。请提醒用户到 https://code.heihuzi.ai/keys 创建绑定「${GROUPS[provider]}」分组的 API Key 并粘贴给你，然后运行：${r.script_command('set-key', provider, '<Key>')}`);
        r.knownKeys.add(key);
        return key;
    };
    r.cmd_set_key = args => {
        const key = args.key.trim();
        r.knownKeys.add(key);
        if ([...key].length < 8 || [...key].length > 512 || /[\s\p{C}\p{Z}]/u.test(key)) throw new UserError('这不像是便利店的 API Key，请让用户到控制台复制完整的 Key');
        const file = r.env_file(), name = KEY_VARS[args.provider];
        const original = r.read_env_text(file);
        let found = false;
        const content = original.replace(/[^\r\n]*(?:\r\n|\r|\n|$)/g, line => {
            if (line.split('=', 1)[0].trim() !== name || !line.includes('=')) return line;
            found = true;
            return name + '=' + key + (line.match(/(?:\r\n|\r|\n)$/)?.[0] || '');
        });
        const updated = found ? content : content + (content && !/[\r\n]$/.test(content) ? '\n' : '') + name + '=' + key + '\n';
        r.fs.mkdirSync(path.dirname(file), { recursive: true });
        const fd = r.fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o600);
        try {
            if (r.platform !== 'win32') r.fs.fchmodSync(fd, 0o600);
            r.fs.ftruncateSync(fd, 0); writeAll(fd, Buffer.from(updated, 'utf8'), r.fs, 0);
        } finally { r.fs.closeSync(fd); }
        return r.emit({ saved: args.provider, file });
    };
    r.task_state = async (task_id, record = null, remove = false) => {
        let lock, candidate, owner, locked = false;
        try {
            const file = path.join(path.dirname(r.env_file()), 'video-tasks.json');
            if (record === null && !r.fs.existsSync(file)) return null;
            r.fs.mkdirSync(path.dirname(file), { recursive: true });
            // 先写入唯一 owner，再原子 rename 发布非空目录。新锁永远不会暴露为空目录，
            // 因此回收者只 unlink 旧 owner + rmdir 空目录，不可能删掉另一代新锁。
            lock = file + '.lock';
            const token = randomUUID();
            owner = `owner-${process.pid}-${token}.json`;
            candidate = lock + '.' + token;
            r.fs.mkdirSync(candidate, { mode: 0o700 });
            r.fs.writeFileSync(path.join(candidate, owner), JSON.stringify({ pid: process.pid, created: Date.now() }), { mode: 0o600 });
            const start = performance.now();
            while (!locked) {
                try {
                    // 兼容旧版尚未过期的空目录锁；rename 在 POSIX 上会覆盖空目录。
                    if (r.fs.existsSync(lock)) throw Object.assign(new Error(), { code: 'EEXIST' });
                    r.fs.renameSync(candidate, lock);
                    candidate = null;
                    locked = true;
                }
                catch (e) {
                    if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(e.code) || performance.now() - start >= 10000) throw e;
                    try {
                        const entries = r.fs.readdirSync(lock);
                        // 死进程立即回收；存活或无法判断的 PID 也不能占住五分钟前的残留锁。
                        // 空目录立刻清掉：新锁一出现就带着 owner 文件，空的说明没人在用。
                        // （Windows 上 owner 文件被杀毒软件占着时，释放之后会留下一个空目录。）
                        if (!entries.length) r.fs.rmdirSync(lock);
                        if (entries.length === 1 && /^owner-\d+-[\da-f-]+\.json$/.test(entries[0])) {
                            const old = path.join(lock, entries[0]);
                            const expired = Date.now() - r.fs.statSync(old).mtimeMs > 300000;
                            const pid = Number(entries[0].split('-')[1]);
                            let dead = false;
                            try { process.kill(pid, 0); } catch (error) { dead = error.code === 'ESRCH'; }
                            if (dead || expired) { r.fs.unlinkSync(old); r.fs.rmdirSync(lock); }
                        }
                    } catch (error) {
                        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
                    }
                    await new Promise(resolve => setTimeout(resolve, 10));
                }
            }
            const fd = r.fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o600);
            try {
                if (r.platform !== 'win32') r.fs.fchmodSync(fd, 0o600);
                let tasks;
                try { tasks = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(r.fs.readFileSync(fd))); } catch { tasks = {}; }
                if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) tasks = {};
                const previous = tasks[task_id];
                if (record !== null || remove) {
                    if (remove) delete tasks[task_id];
                    else Object.defineProperty(tasks, task_id, { value: record, enumerable: true, configurable: true, writable: true });
                    tasks = Object.fromEntries(Object.entries(tasks).filter(([, v]) => v && !Array.isArray(v) && typeof v === 'object' && typeof v.created === 'number' && Number.isFinite(v.created)).sort((a, b) => a[1].created - b[1].created).slice(-50));
                    r.fs.ftruncateSync(fd, 0); writeAll(fd, Buffer.from(json(tasks), 'utf8'), r.fs, 0);
                }
                return previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : null;
            } finally { r.fs.closeSync(fd); }
        } catch {
            await r.warn_output('提示：无法读取或保存视频任务费用状态，费用可能暂未查到。'); return null;
        } finally {
            const directory = locked ? lock : candidate;
            if (directory) {
                try { r.fs.unlinkSync(path.join(directory, owner)); } catch {}
                try { r.fs.rmdirSync(directory); } catch {}
            }
        }
    };
    r.spent = async (provider, timeout = 15) => {
        try {
            const raw = await r.request(r.BASE_URL + '/v1/usage', { timeout, headers: { 'User-Agent': `video-gen/${VERSION}`, Authorization: 'Bearer ' + r.api_key(provider), Accept: 'application/json' } });
            const total = JSON.parse(raw).usage.total;
            // JSON.parse 会把 4.0 和 4 都变成整数；原版只接受整数形式的请求数。
            const integerOnly = JSON.parse(String(raw).replace(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
                token => token[0] !== '"' && /[.eE]/.test(token) ? 'null' : token));
            if (integerOnly.usage.total.requests !== total.requests) return null;
            const cost = typeof total.actual_cost === 'string' && total.actual_cost.trim() ? Number(total.actual_cost) : total.actual_cost;
            if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0 || !Number.isInteger(total.requests) || total.requests < 0) return null;
            return [cost, total.requests];
        } catch { return null; }
    };
    r.cost_of = async record => {
        if (!record) return [null, null];
        const before = record.before_cost, requests = record.before_requests;
        if (typeof before !== 'number' || !Number.isFinite(before) || before < 0 || !Number.isInteger(requests) || requests < 0 || !Object.hasOwn(KEY_VARS, record.provider)) return [null, null];
        const deadline = r.monotonic() + 60;
        let count = null;
        for (let attempt = 0; attempt < 21; attempt++) {
            let remaining = deadline - r.monotonic();
            if (remaining <= 0) break;
            const after = await r.spent(record.provider, Math.min(15, remaining));
            count = after === null || after[1] < requests ? null : after[1] - requests;
            if (count) { const delta = after[0] - before; return [delta >= 0 ? Number(fixed(delta, 6)) : null, count]; }
            remaining = deadline - r.monotonic();
            if (attempt < 20 && remaining > 0) await r.sleep(Math.min(3, remaining));
        }
        return [null, count];
    };
    r.summary_lines = (info, cost, count) => {
        const lines = []; let model = info.model;
        if (model) { try { model = MODEL_NAMES[r.resolve_model(model)[0]]; } catch (e) { if (!(e instanceof UserError)) throw e; } lines.push(`模型：${model}`); }
        if (info.resolution) lines.push(`清晰度：${info.resolution}`);
        if (info.duration !== undefined && info.duration !== null) lines.push(`时长：${info.duration} 秒`);
        let fee = cost !== null ? '¥' + fixed(cost, 4) : '暂未查到';
        if (cost !== null && count !== null && count > 1) fee += `（这段时间这把 Key 共 ${count} 次扣费的合计，含其他任务）`;
        return lines.concat(`生成费用：${fee}`);
    };
    r.call = async (method, endpoint, provider, body = null) => {
        const data = Buffer.isBuffer(body) ? body : body === null ? null : Buffer.from(json(body));
        const headers = { 'User-Agent': `video-gen/${VERSION}`, Authorization: 'Bearer ' + r.api_key(provider), 'Content-Type': 'application/json', Accept: 'application/json' };
        if (data !== null) headers['Content-Length'] = String(data.length);
        let raw;
        try { raw = await r.request(r.BASE_URL + endpoint, { method, headers, body: data, timeout: 120 }); }
        catch (error) {
            if (!(error instanceof HTTPError)) throw error;
            let message = error.raw;
            try { message = JSON.parse(error.raw).error?.message || error.raw; } catch {}
            // 接口错误体可能回显密钥，不能直接打印。
            for (const key of [r.api_key(provider), ...Object.values(KEY_VARS).map(k => r.env[k]), r.env.HEIHUZI_API_KEY]) if (key) message = String(message).split(key).join('<Key>');
            const hint = [401, 403].includes(error.status) ? ` Key 可能填错了或不是「${GROUPS[provider]}」分组的，请让用户重新提供，用 ${r.script_command('set-key', provider, '<Key>')} 覆盖。` : '';
            throw new UserError(`接口返回 ${error.status}：${message}${hint}`);
        }
        // 网关偶尔会回一个网页（状态码却是 200）。这不是脚本自己的毛病，不要说成“脚本内部出错”，说法和图片创作对齐。
        try { return JSON.parse(raw); }
        catch { throw new UserError('接口响应不是有效 JSON。如果刚才是在提交视频，请先到便利店后台的使用记录确认有没有提交成功，不要直接重试。'); }
    };
    r.build_seedance = (model, args) => {
        const content = [{ type: 'text', text: args.prompt }];
        for (const [role, value] of [['first_frame', args.first_frame], ['last_frame', args.last_frame]])
            if (value) content.push({ type: 'image_url', image_url: { url: r.image_url(value, 'seedance') }, role });
        for (const value of args.reference || []) content.push({ type: 'image_url', image_url: { url: r.image_url(value, 'seedance') }, role: 'reference_image' });
        const has_frames = !!(args.first_frame || args.last_frame);
        if (args.last_frame && !args.first_frame) throw new UserError('尾帧要和首帧一起用');
        if (has_frames && args.reference?.length) throw new UserError('首尾帧和参考图不能同时用，请二选一');
        if (content.length > 1 && !model.images) throw new UserError('这个模型目前只支持文生视频；用图片请选 seedance-2.0-fast 或 seedance-2.0');
        return r.encode_request({ model: model.id, content, resolution: args.resolution || '480p', ratio: args.ratio || (has_frames ? 'adaptive' : '16:9'), duration: args.duration });
    };
    r.build_minimax = (model, args) => {
        if (args.last_frame || args.reference?.length) throw new UserError('MiniMax 目前只支持首帧图，不支持尾帧和参考图');
        const content = [{ type: 'text', text: args.prompt }];
        const body = { model: model.id, content, resolution: args.resolution || '480P', duration: args.duration };
        if (args.first_frame) {
            content.push({ type: 'image_url', role: 'first_frame', image_url: { url: r.image_url(args.first_frame, 'minimax') } });
            if (args.ratio) body.ratio = args.ratio;
        } else body.ratio = args.ratio || '16:9';
        return r.encode_request(body);
    };
    r.fetch_status = async (task_id, metadata = null) => {
        if (!validTaskId(task_id)) throw new UserError('任务号格式无效，不允许路径或控制字符。');
        const provider = task_id.startsWith('video_') ? 'minimax' : 'seedance';
        const response = await r.call('GET', provider === 'minimax' ? `/v2/query/video_generation/${task_id}` : `/api/v3/contents/generations/tasks/${task_id}`, provider);
        const task = provider === 'minimax' ? response.task || {} : response;
        const url = task.content?.[provider === 'minimax' ? 'url' : 'video_url'];
        if (metadata !== null) for (const key of ['model', 'resolution', 'duration']) if (Object.hasOwn(task, key)) metadata[key] = task[key];
        return { task_id, status: task.status ?? null, video_url: url || null, error: task.error || null };
    };
    r.cmd_check = async () => {
        let file = ''; try { file = r.env_file(); } catch {}
        const keys = {};
        for (const provider of Object.keys(KEY_VARS)) {
            try { keys[provider] = !!r.api_key(provider); }
            catch (e) { keys[provider] = false; if (!(e instanceof UserError)) await r.warn_output('提示：无法读取 Key 配置，请检查 env 文件路径、权限和编码。'); }
        }
        const lines = [`视频创作已就绪（版本 ${VERSION}）。`];
        if (keys.seedance) {
            lines.push('Key 已经设置好了，不用再设置。');
            if (!keys.minimax) lines.push('想用 MiniMax 做视频时，再建一个分组选「MiniMax 视频」的 Key 发给我。');
        } else lines.push('还差一步：请打开 https://code.heihuzi.ai/keys ，新建一个 API Key，分组选「Seedance 视频」，然后把 Key 粘贴给我。', '想用 MiniMax 做视频，再建一个分组选「MiniMax 视频」的 Key 发给我。');
        lines.push((keys.seedance ? '' : '设置好以后，') + '直接说想做什么就行，比如：',
            '- 用桌面上的 apple.jpg 当第一个画面，做一段手摘下苹果的 5 秒视频', '- 做一段海浪拍打沙滩的 5 秒视频',
            '默认用 Seedance 2.0 Fast、480p、5 秒；每次生成前我会先跟你确认模型和时长，做好后视频存到你的电脑上，并告诉你这次实际花了多少。',
            '提醒：Codex 要重启后才能用新装的 skill；Claude Code 新开一个对话就行。');
        try {
            await r.emit({ skill: 'video-gen', version: VERSION, node: process.versions.node, keys, env_file: file });
            for (const line of lines) await r.write_output(line);
        } catch (e) { if (!(e instanceof OutputError)) throw e; await r.warn_output('提示：无法输出安装引导，请检查终端或输出管道。'); }
    };
    r.cmd_models = async () => {
        for (const [alias, model] of Object.entries(MODELS)) await r.emit({ model: alias, provider: model.provider,
            abilities: model.provider === 'minimax' ? '文生视频、首帧' : model.images ? '文生视频、首帧、首尾帧、参考图' : '文生视频' });
    };
    r.cmd_create = async args => {
        if (!args.prompt.trim()) throw new UserError('请写画面描述（--prompt）');
        if (args.duration !== 5) await r.write_output('提示：便利店文档实测的是 5 秒，其他时长按火山/MiniMax 官方规则处理', true);
        const [alias, model] = r.resolve_model(args.model);
        const body = model.provider === 'seedance' ? r.build_seedance(model, args) : r.build_minimax(model, args);
        const before = await r.spent(model.provider), created = r.now();
        const result = await r.call('POST', model.provider === 'seedance' ? '/api/v3/contents/generations/tasks' : '/v2/video_generation', model.provider, body);
        const task_id = model.provider === 'seedance' ? result.id : result.task_id;
        if (!task_id) throw new UserError(`提交后没有拿到任务号：${json(result, false).slice(0, 300)}`);
        if (!validTaskId(task_id)) throw new UserError('已收到服务响应，但任务号格式无法安全使用，请到后台核对原任务，不要重复提交。');
        await r.task_state(task_id, { provider: model.provider, model: alias, resolution: args.resolution || (model.provider === 'seedance' ? '480p' : '480P'),
            duration: args.duration, before_cost: before?.[0] ?? null, before_requests: before?.[1] ?? null, created });
        await r.emit({ task_id, model: alias, status: 'submitted' });
    };
    r.cmd_status = async args => await r.emit(await r.fetch_status(args.task_id));
    r.download = async (url, out_dir, task_id) => {
        if (!validTaskId(task_id)) throw new UserError('任务号格式无效，不允许路径或控制字符。');
        out_dir = path.resolve(r.expanduser(out_dir)); r.fs.mkdirSync(out_dir, { recursive: true });
        const temporary = path.join(out_dir, `.${task_id}.${randomUUID()}.part`);
        try {
            await r.request(url, { timeout: 300, target: temporary, headers: { 'User-Agent': `video-gen/${VERSION}` } });
            const stat = r.fs.statSync(temporary);
            if (!stat.isFile() || !stat.size) throw new UserError('下载的成片为空，请继续查询原任务；已有文件未被替换。');
            // 同目录发布完整文件；link 的排他语义保证并发下载也不覆盖旧视频。
            for (let suffix = 0; ; suffix++) {
                const target = path.join(out_dir, `${task_id}${suffix ? '-' + suffix : ''}.mp4`);
                try { r.fs.linkSync(temporary, target); return target; }
                catch (error) { if (error.code !== 'EEXIST') throw error; }
            }
        } finally {
            try { r.fs.unlinkSync(temporary); } catch {}
        }
    };
    r.cmd_wait = async args => {
        const deadline = r.monotonic() + args.timeout, metadata = {};
        while (true) {
            const state = await r.fetch_status(args.task_id, metadata), status = state.status;
            if (status === 'succeeded') {
                if (!state.video_url) throw new UserError('任务成功但没有成片链接，请稍后用 status 再查');
                const target = await r.download(state.video_url, args.out, args.task_id);
                const record = await r.task_state(args.task_id);
                let cost, count;
                try { [cost, count] = args.no_cost ? [null, null] : await r.cost_of(record); }
                finally { await r.task_state(args.task_id, null, true); }
                try {
                    await r.emit({ task_id: args.task_id, status: 'succeeded', file: target, cost, cost_requests: count });
                    if (!args.no_cost) { Object.assign(metadata, record || {}); for (const line of r.summary_lines(metadata, cost, count)) await r.write_output(line); }
                } catch (e) { if (!(e instanceof OutputError)) throw e; await r.warn_output(`提示：视频已保存到 ${target}，但结果输出失败，请直接查看该文件。`); }
                return;
            }
            if (['failed', 'expired', 'cancelled'].includes(status)) {
                await r.task_state(args.task_id, null, true); await r.emit(state);
                throw new UserError(`任务没有成功（${status}），请在服务后台核对余额及退款状态`);
            }
            if (r.monotonic() > deadline) throw new UserError(`等了 ${args.timeout} 秒还没完成，任务号 ${args.task_id}，稍后用 status 再查`);
            await r.write_output(`生成中（${status ?? 'None'}），${args.interval} 秒后再查…`, true); await r.sleep(args.interval);
        }
    };
    r.main = async (argv = process.argv.slice(2)) => {
        try {
            try { r.configure(false); r.configure(true); }
            catch { await r.warn_output('错误：无法设置终端输出编码，请检查输出管道。'); if (argv.length !== 1 || argv[0] !== 'check') return 1; }
            const args = await parseArgs(argv, r);
            if (typeof args === 'number') return args;
            await r['cmd_' + args.command.replace('-', '_')](args);
            return 0;
        } catch (error) {
            if (error instanceof UserError) {
                let message = error.message;
                // 本机报错里的路径、模型名、服务端回包也可能带上已知 Key。
                for (const key of [...Object.values(KEY_VARS).map(k => r.env[k]), r.env.HEIHUZI_API_KEY]) if (key) message = message.split(key).join('<Key>');
                await r.warn_output('错误：' + message);
            } else if (error instanceof OutputError) await r.warn_output('错误：无法输出结果或提示，请检查终端或输出管道。');
            else if (error instanceof NetworkError) await r.warn_output('错误：网络请求失败，请检查连接；如已提交，请用任务号查询进度。');
            else if ((typeof error?.code === 'string' && typeof error?.syscall === 'string') ||
                ['ERR_ENCODING_INVALID_ENCODED_DATA', 'ERR_UNKNOWN_ENCODING'].includes(error?.code)) {
                await r.warn_output('错误：无法读取或保存本机文件，请检查路径、权限和编码。');
            } else {
                const name = String(error?.name || 'Error').replace(/[\r\n\u2028\u2029]+/g, ' ');
                const message = String(error?.message ?? error).replace(/[\r\n\u2028\u2029]+/g, ' ');
                await r.warn_output(`错误：脚本内部出错（${name}：${message}）。如果刚才是在提交视频，请先到便利店后台的使用记录确认有没有提交成功，不要直接重试。`);
            }
            return 1;
        }
    };
    return r;
}

// 保留原参数帮助的布局和文字。
const HELP = {
    "": "usage: {prog} [-h] {models,check,set-key,create,status,wait} ...\n\n视频创作\n\npositional arguments:\n  {models,check,set-key,create,status,wait}\n    models              列出支持的模型\n    check               检查安装并显示下一步引导（不联网）\n    set-key             把用户粘贴的 Key 存进本机 env 文件\n    create              提交视频任务（会扣费）\n    status              查询一次任务状态\n    wait                等待完成并下载成片\n\noptional arguments:\n  -h, --help            show this help message and exit\n",
    "models": "usage: {prog} models [-h]\n\noptional arguments:\n  -h, --help  show this help message and exit\n",
    "check": "usage: {prog} check [-h]\n\noptional arguments:\n  -h, --help  show this help message and exit\n",
    "set-key": "usage: {prog} set-key [-h] {seedance,minimax} key\n\npositional arguments:\n  {seedance,minimax}\n  key\n\noptional arguments:\n  -h, --help          show this help message and exit\n",
    "create": "usage: {prog} create [-h] [--model MODEL] --prompt PROMPT\n                               [--first-frame FIRST_FRAME]\n                               [--last-frame LAST_FRAME]\n                               [--reference REFERENCE]\n                               [--resolution RESOLUTION] [--duration DURATION]\n                               [--ratio RATIO]\n\noptional arguments:\n  -h, --help            show this help message and exit\n  --model MODEL         默认 seedance-2.0-fast；另有 seedance-2.0、minimax-h3-max\n                        等，见 models\n  --prompt PROMPT       画面与动作描述\n  --first-frame FIRST_FRAME\n                        首帧图：本机路径或 https 链接\n  --last-frame LAST_FRAME\n                        尾帧图（仅 Seedance 2.0，需同时给首帧）\n  --reference REFERENCE\n                        参考图（仅 Seedance 2.0，可重复）\n  --resolution RESOLUTION\n                        清晰度，默认 Seedance 480p、MiniMax 480P\n  --duration DURATION   时长（秒），默认 5\n  --ratio RATIO         画面比例；有首帧时默认由图片决定，文生默认 16:9\n",
    "status": "usage: {prog} status [-h] task_id\n\npositional arguments:\n  task_id\n\noptional arguments:\n  -h, --help  show this help message and exit\n",
    "wait": "usage: {prog} wait [-h] [--out OUT] [--interval INTERVAL]\n                             [--timeout TIMEOUT] [--no-cost]\n                             task_id\n\npositional arguments:\n  task_id\n\noptional arguments:\n  -h, --help           show this help message and exit\n  --out OUT            成片保存目录，默认当前目录\n  --interval INTERVAL  查询间隔（秒）\n  --timeout TIMEOUT    最多等待秒数\n  --no-cost            不查询费用、不输出摘要\n"
};
async function parseArgs(argv, r) {
    const prog = path.basename(r.script);
    const commands = ['models', 'check', 'set-key', 'create', 'status', 'wait'];
    let command = '', args = {}, positionals = [], extras = [];
    const text = cmd => HELP[cmd].replace(/\{prog\}/g, prog);
    const usage = cmd => text(cmd).split('\n\n')[0];
    const redact = s => {
        const secrets = [...Object.values(KEY_VARS).map(k => r.env[k]), r.env.HEIHUZI_API_KEY];
        if (argv[0] === 'set-key' && argv[2]) secrets.push(argv[2]);
        for (const secret of secrets) if (secret) s = s.split(secret).join('<Key>');
        return s.replace(/sk-[^\s'",)]+/g, '<Key>');
    };
    const fail = async message => { await r.write_output(usage(command) + '\n' + prog + (command ? ' ' + command : '') + ': error: ' + redact(message), true); return 2; };
    if (['-h', '--help'].includes(argv[0])) { await r.write_output(text('').replace(/\n$/, '')); return 0; }
    if (!argv.length) return fail('the following arguments are required: command');
    if (!commands.includes(argv[0])) {
        if (argv[0].startsWith('-')) return fail('the following arguments are required: command');
        return fail(`argument command: invalid choice: '${argv[0]}' (choose from 'models', 'check', 'set-key', 'create', 'status', 'wait')`);
    }
    command = argv[0];
    args = { command };
    const spec = command === 'create' ? ['model', 'prompt', 'first-frame', 'last-frame', 'reference', 'resolution', 'duration', 'ratio'] : command === 'wait' ? ['out', 'interval', 'timeout', 'no-cost'] : [];
    if (command === 'create') Object.assign(args, { model: 'seedance-2.0-fast', prompt: null, first_frame: null, last_frame: null, reference: null, resolution: null, duration: 5, ratio: null });
    if (command === 'wait') Object.assign(args, { out: '.', interval: 15, timeout: 1800, no_cost: false });
    let literal = false;
    for (let i = 1; i < argv.length; i++) {
        const token = argv[i];
        if (!literal && token === '--') { literal = true; continue; }
        if (!literal && ['-h', '--help'].includes(token)) { await r.write_output(text(command).replace(/\n$/, '')); return 0; }
        if (!literal && token.startsWith('--')) {
            const equal = token.indexOf('='), option = token.slice(2, equal < 0 ? undefined : equal);
            const matches = spec.includes(option) ? [option] : spec.filter(o => o.startsWith(option));
            if (matches.length > 1) return fail(`ambiguous option: --${option} could match ${matches.map(m => '--' + m).join(', ')}`);
            if (!matches.length) { extras.push(token); continue; }
            const name = matches[0]; let value;
            if (name === 'no-cost') { if (equal >= 0) return fail(`argument --no-cost: ignored explicit argument '${token.slice(equal + 1)}'`); args.no_cost = true; continue; }
            if (equal >= 0) value = token.slice(equal + 1);
            else {
                value = argv[i + 1];
                if (value === undefined || (value.startsWith('-') && !/^-\d+(\.\d+)?$/.test(value))) return fail(`argument --${name}: expected one argument`);
                i++;
            }
            if (['duration', 'interval', 'timeout'].includes(name)) {
                if (!/^[+-]?\d(?:_?\d)*$/.test(value.trim())) return fail(`argument --${name}: invalid int value: '${value}'`);
                value = Number(value.replace(/_/g, ''));
            }
            const field = name.replace(/-/g, '_');
            if (name === 'reference') { if (!args.reference) args.reference = []; args.reference.push(value); } else args[field] = value;
        } else if (!literal && token.startsWith('-') && token !== '-' && !/^-\d+(\.\d+)?$/.test(token)) extras.push(token);
        else positionals.push(token);
    }
    if (command === 'create' && args.prompt === null) return fail('the following arguments are required: --prompt');
    const positionalNames = command === 'set-key' ? ['provider', 'key'] : ['status', 'wait'].includes(command) ? ['task_id'] : [];
    if (command === 'set-key' && positionals.length && !['seedance', 'minimax'].includes(positionals[0])) return fail(`argument provider: invalid choice: '${positionals[0]}' (choose from 'seedance', 'minimax')`);
    if (positionals.length < positionalNames.length) return fail('the following arguments are required: ' + positionalNames.slice(positionals.length).join(', '));
    positionalNames.forEach((key, i) => { args[key] = positionals[i]; });
    extras.push(...positionals.slice(positionalNames.length));
    if (extras.length) { command = ''; return fail('unrecognized arguments: ' + extras.join(' ')); }
    if (command === 'create' && (!Number.isSafeInteger(args.duration) || args.duration <= 0)) return fail('--duration must be a positive integer');
    if (command === 'wait' && ['interval', 'timeout'].some(key => !Number.isSafeInteger(args[key]) || args[key] <= 0))
        return fail('--interval and --timeout must be positive integers');
    if (['status', 'wait'].includes(command) && !validTaskId(args.task_id))
        return fail('task_id must be a safe identifier, without path or control characters');
    return args;
}

export function isDirectRun(moduleURL, entry = process.argv[1], filesystem = fs, platform = process.platform) {
    if (!entry) return false; // node -e / REPL 导入没有入口文件。
    try {
        const canonical = value => {
            const resolved = filesystem.realpathSync(value);
            return platform === 'win32' ? resolved.toLowerCase() : resolved;
        };
        return canonical(entry) === canonical(fileURLToPath(moduleURL));
    } catch { return true; } // 无法判断时执行并报告错误，不能静默成功。
}

if (isDirectRun(import.meta.url)) {
    try {
        createRuntime().main().then(code => { process.exitCode = code; });
    } catch (error) {
        process.stderr.write('错误：' + error.message + '\n');
        process.exitCode = 1;
    }
}
