"""Read the signed-in Google account directly from the Flow bootstrap page.

The Flow frontend embeds the account in ``WIZ_global_data`` as ``oPEP7c``. That
lets the server identify an account from its cookies alone, so the browser
extension never has to know (or be told) which Google account it is serving.
"""

import re
from typing import Optional

from curl_cffi.requests import AsyncSession

from .browser_cookie_utils import serialize_cookie_header_for_url

FLOW_HOME_URL = "https://flow.google.com/"
_BOOTSTRAP_EMAIL = re.compile(r'"oPEP7c"\s*:\s*"([^"@\s]{1,64}@[^"\s]{3,253})"')
# Safety net when the bootstrap shape changes: the first address on the page.
_FALLBACK_EMAIL = re.compile(r"[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}")
_MAX_SCAN = 800_000


async def resolve_account_email(
    google_cookies: str, timeout: int = 20
) -> Optional[str]:
    """Return the Google account email for this cookie set, or None."""
    cookie_header = serialize_cookie_header_for_url(google_cookies, FLOW_HOME_URL)
    if not cookie_header:
        return None

    try:
        async with AsyncSession(trust_env=False) as session:
            response = await session.get(
                FLOW_HOME_URL,
                headers={
                    "Cookie": cookie_header,
                    "Accept-Language": "en-US,en;q=0.9",
                },
                impersonate="chrome",
                timeout=timeout,
                allow_redirects=True,
            )
    except Exception:
        return None

    if response.status_code != 200:
        return None

    body = response.text[:_MAX_SCAN]
    match = _BOOTSTRAP_EMAIL.search(body)
    email = match.group(1) if match else ""
    if not email:
        fallback = _FALLBACK_EMAIL.search(body)
        email = fallback.group(0) if fallback else ""
    email = email.strip().lower()
    if "@" not in email or len(email) > 254:
        return None
    return email
