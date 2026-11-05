console.log("[Flow2API] Captcha Worker injected.");

function getRecaptchaToken(action) {
    return new Promise((resolve, reject) => {
        const reqId = Date.now() + Math.random().toString();
        const script = document.createElement("script");
        script.textContent = `
            try {
                function runCaptcha() {
                    const storageKey = '__flow2apiTrustedRecaptchaExecute';
                    const execute = window[storageKey]
                        || (window.grecaptcha && window.grecaptcha.enterprise
                            ? window.grecaptcha.enterprise.execute
                            : null);
                    if (typeof execute !== 'function') {
                        window.postMessage({type: 'reCAPTCHA_error', reqId: '${reqId}', error: 'reCAPTCHA execute is unavailable'}, '*');
                        return;
                    }
                    let target = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';
                    try {
                        if (!window[storageKey] && window.grecaptcha.enterprise
                            && typeof window.grecaptcha.enterprise.render === 'function'
                            && window.__flow2apiRecaptchaClientId === undefined) {
                            window.__flow2apiRecaptchaClientId = window.grecaptcha.enterprise.render(
                                document.documentElement,
                                { sitekey: target, action: '${action}' }
                            );
                        }
                        if (window.__flow2apiRecaptchaClientId !== undefined) {
                            target = window.__flow2apiRecaptchaClientId;
                        }
                    } catch (e) {}
                    Promise.resolve(execute(target, {action: '${action}'}))
                        .then(token => window.postMessage({type: 'reCAPTCHA_result', reqId: '${reqId}', token: token}, '*'))
                        .catch(err => window.postMessage({type: 'reCAPTCHA_error', reqId: '${reqId}', error: err.message}, '*'));
                }
                
                if (typeof grecaptcha !== "undefined" && grecaptcha.enterprise) {
                    runCaptcha();
                } else {
                    const rScript = document.createElement('script');
                    rScript.src = "https://www.google.com/recaptcha/enterprise.js?render=6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV";
                    rScript.onload = () => { runCaptcha(); };
                    rScript.onerror = () => { window.postMessage({type: 'reCAPTCHA_error', reqId: '${reqId}', error: 'Failed to load enterprise.js'}, '*'); };
                    document.head.appendChild(rScript);
                }
            } catch (e) {
                window.postMessage({type: 'reCAPTCHA_error', reqId: '${reqId}', error: e.message}, '*');
            }
        `;
        
        const listener = (event) => {
            if (event.source !== window || !event.data) return;
            if (event.data.reqId === reqId) {
                window.removeEventListener("message", listener);
                script.remove();
                if (event.data.type === 'reCAPTCHA_result') {
                    resolve(event.data.token);
                } else {
                    reject(new Error(event.data.error || "Unknown reCAPTCHA Error"));
                }
            }
        };
        window.addEventListener("message", listener);
        document.documentElement.appendChild(script);
        
        setTimeout(() => {
            window.removeEventListener("message", listener);
            script.remove();
            reject(new Error("Timeout generating reCAPTCHA"));
        }, 15000);
    });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "get_token") {
        console.log("[Flow2API] Generating token for action: " + message.action);
        getRecaptchaToken(message.action)
            .then(token => sendResponse({status: "success", token: token}))
            .catch(err => sendResponse({status: "error", error: err.message}));
        return true; 
    }
});

