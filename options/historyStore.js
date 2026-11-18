(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.OptionsHistory = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
    const LEGACY_KEY = 'kkgo1999.aiAnalysisHistory';
    function scrub(value) {
        if (Array.isArray(value)) return value.map(scrub);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
            .filter(([key]) => !/apikey|authorization|password|secret|__proto__|constructor|prototype/i.test(key))
            .map(([key, val]) => [key, scrub(val)]));
        return value;
    }
    function normalizeEntry(value) {
        if (!value || typeof value.id !== 'string' || !value.id || value.id.length > 200 ||
            !Number.isFinite(Date.parse(value.createdAt)) || typeof value.summary !== 'string' ||
            !Array.isArray(value.rows) || value.rows.length > 10 ||
            (value.notes != null && !Array.isArray(value.notes))) throw new Error('历史记录格式无效');
        const numericFields = ['daysToExpiry', 'strike', 'stockPrice', 'strikePct', 'bid', 'ask', 'spreadPct',
            'openInterest', 'volume', 'annualReturn', 'collateral', 'breakEven', 'downsideProtectionPct', 'localScore'];
        const rows = value.rows.map((row, index) => {
            const candidate = row.candidate;
            if (!candidate || typeof candidate.symbol !== 'string' || !/^[A-Z0-9.^-]{1,20}$/.test(candidate.symbol) ||
                !['put', 'call'].includes(candidate.optionType) || !/^\d{4}-\d{2}-\d{2}$/.test(candidate.expiryDate)) {
                throw new Error('历史候选格式无效');
            }
            for (const key of numericFields) {
                if (!(key === 'volume' && candidate[key] == null) && !Number.isFinite(candidate[key])) throw new Error('历史数值格式无效');
            }
            return { rank: index + 1, reason: String(row.reason || ''), risk: String(row.risk || ''),
                confidence: ['高', '中', '低'].includes(row.confidence) ? row.confidence : '中',
                candidate: {
                    id: String(candidate.id || ''), symbol: candidate.symbol, optionType: candidate.optionType,
                    expiryDate: candidate.expiryDate, strategy: String(candidate.strategy || ''),
                    contractSymbol: String(candidate.contractSymbol || ''),
                    ...Object.fromEntries(numericFields.map(key => [key, candidate[key] ?? null]))
                }
            };
        });
        return scrub({
            id: value.id, createdAt: value.createdAt, summary: value.summary, rows,
            provider: value.provider || 'glm', model: value.model || '未记录（旧版）',
            promptVersion: value.promptVersion || 'legacy', notes: (value.notes || []).filter(note => typeof note === 'string'),
            settings: value.settings || {}, analysisData: value.analysisData || null,
            streamCapture: {
                provider: value.provider || 'glm', model: value.model || '未记录（旧版）', status: '历史记录',
                reasoning: String(value.streamCapture?.reasoning || ''), content: String(value.streamCapture?.content || ''),
                usage: value.streamCapture?.usage || null, responseId: value.streamCapture?.responseId || null
            }
        });
    }

    function availableStorage() {
        try { return globalThis.localStorage; } catch { return null; }
    }

    function createStore({ indexedDB = globalThis.indexedDB, storage = availableStorage(),
        name = 'kkgo1999-options-history' } = {}) {
        const opened = new Promise((resolve, reject) => {
            if (!indexedDB) return reject(new Error('浏览器不支持历史数据库，请导出本次结果备份'));
            const request = indexedDB.open(name, 1);
            request.onupgradeneeded = () => request.result.createObjectStore('entries', { keyPath: 'id' });
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error('历史数据库被其他页面占用，请关闭旧页面后重试'));
            request.onsuccess = () => {
                request.result.onversionchange = () => request.result.close();
                resolve(request.result);
            };
        });
        function transaction(db, mode, operation) {
            return new Promise((resolve, reject) => {
                const tx = db.transaction('entries', mode);
                let value;
                tx.oncomplete = () => resolve(value);
                tx.onerror = tx.onabort = () => reject(tx.error || new Error('历史写入失败'));
                operation(tx.objectStore('entries'), result => { value = result; });
            });
        }
        function merge(db, entries) {
            return transaction(db, 'readwrite', store => {
                for (const entry of entries) {
                    const existing = store.get(entry.id);
                    existing.onsuccess = () => { if (!existing.result) store.put(entry); };
                }
            });
        }
        const ready = opened.then(async db => {
            const raw = storage?.getItem(LEGACY_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (!Array.isArray(parsed)) throw new Error('旧历史格式损坏，已保留原数据');
                await merge(db, parsed.map(normalizeEntry));
                storage.removeItem(LEGACY_KEY);
            }
            return db;
        });
        return {
            ready,
            async list() {
                const db = await ready;
                const entries = await transaction(db, 'readonly', (store, done) => {
                    const request = store.getAll();
                    request.onsuccess = () => done(request.result);
                });
                return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
            },
            async put(entry) {
                const clean = normalizeEntry(entry);
                const db = await ready;
                await transaction(db, 'readwrite', store => { store.put(clean); });
            },
            async remove(id) {
                const db = await ready;
                await transaction(db, 'readwrite', store => { store.delete(id); });
            },
            async clear() {
                const db = await ready;
                await transaction(db, 'readwrite', store => { store.clear(); });
            },
            async importFile(text) {
                if (text.length > 50 * 1024 * 1024) throw new Error('历史文件超过 50 MB，请分批导入');
                const data = JSON.parse(text);
                if (data?.schemaVersion !== 1 || !Array.isArray(data.entries)) throw new Error('不是受支持的历史备份');
                const entries = data.entries.map(normalizeEntry);
                const db = await ready;
                await merge(db, entries);
            }
        };
    }
    return { createStore, normalizeEntry };
});
