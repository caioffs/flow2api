// Runs in the page MAIN world at document_start, BEFORE any Flow script.
//
// New Flow replaces the public `grecaptcha.enterprise.execute` wrapper with an
// assignment that overwrites the caller action with "extension_hijack_detected".
// That action mismatch is what makes Google answer PUBLIC_ERROR_UNUSUAL_ACTIVITY
// on the generation RPC.
//
// The fix mirrors src/services/recaptcha_runtime.py (TRUSTED_RECAPTCHA_HOOK_SOURCE):
//   1. capture the original (bound) enterprise.execute before Flow wraps it
//   2. strip the `action: 'extension_hijack_detected'` override from Object.assign
(() => {
    if (window.__flow2apiTrustedRecaptchaHookInstalled) return;
    Object.defineProperty(
        window,
        '__flow2apiTrustedRecaptchaHookInstalled',
        { value: true }
    );

    const storageKey = '__flow2apiTrustedRecaptchaExecute';
    const originalBind = Function.prototype.bind;
    Function.prototype.bind = function (thisArg, ...args) {
        const bound = originalBind.call(this, thisArg, ...args);
        try {
            const enterprise = window.grecaptcha && window.grecaptcha.enterprise;
            if (
                !window[storageKey] &&
                enterprise &&
                this === enterprise.execute &&
                typeof bound === 'function'
            ) {
                window[storageKey] = bound;
            }
        } catch (error) {}
        return bound;
    };

    Object.defineProperty(
        window,
        '__flow2apiRecaptchaActionGuardInstalled',
        { value: true }
    );
    const originalAssign = Object.assign;
    Object.assign = function (target, ...sources) {
        let nextSources = sources;
        if (sources.length >= 2) {
            const previous = sources[sources.length - 2];
            const last = sources[sources.length - 1];
            if (
                previous &&
                typeof previous.action === 'string' &&
                previous.action &&
                last &&
                last.action === 'extension_hijack_detected'
            ) {
                nextSources = sources.slice(0, -1);
            }
        }
        return originalAssign.call(this, target, ...nextSources);
    };
})();
