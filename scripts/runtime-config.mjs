import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';

export function loadRuntimeConfig(moduleURL, fields) {
    const root = path.resolve(path.dirname(fileURLToPath(moduleURL)), '..');
    let settings;
    try {
        settings = JSON.parse(fs.readFileSync(path.join(root, 'config', 'runtime.json'), 'utf8').replace(/^\uFEFF/, ''));
    } catch {
        throw new Error('无法读取 config/runtime.json，请检查文件是否存在及 JSON 格式。');
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings) ||
        Object.keys(settings).some(key => !Object.hasOwn(fields, key)) ||
        Object.entries(fields).some(([key, type]) => typeof settings[key] !== type)) {
        throw new Error('config/runtime.json 字段缺失、类型错误或包含未知字段。');
    }
    const resolvePath = value => {
        if (!value) return '';
        const expanded = value === '~' ? os.homedir() : /^~[/\\]/.test(value) ? path.join(os.homedir(), value.slice(2)) : value;
        return path.resolve(root, expanded);
    };
    return {settings, resolvePath};
}
