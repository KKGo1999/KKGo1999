(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.OptionsAsync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
    function createRequestGate() {
        let active = null;
        return {
            start() {
                active?.abort();
                active = new AbortController();
                return active;
            },
            current(run) { return run === active && !run.signal.aborted; },
            cancel() { active?.abort(); active = null; }
        };
    }
    return { createRequestGate };
});
