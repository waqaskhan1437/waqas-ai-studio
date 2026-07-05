import { AuthContext, Env, SocialAccount, SocialSettings } from "../types";
import { jsonResponse, safeRequestJson } from "../utils";
import { getScopedSettings, upsertScopedSettings, SETTINGS_TABLES } from "../services/user-settings";

const FB_API_BASE = "https://graph.facebook.com/v21.0";
const FB_DIALOG = "https://www.facebook.com/v21.0/dialog/oauth";

export async function handleOAuthRoutes(
  request: Request,
  env: Env,
  path: string,
  auth: AuthContext | null
): Promise<Response> {
  const method = request.method;
  const url = new URL(request.url);

  if (path === "/api/oauth/facebook/callback" && method === "GET") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const errorParam = url.searchParams.get("error");

    if (errorParam) {
      return jsonResponse({ success: false, error: `Facebook OAuth error: ${errorParam}` }, 400);
    }
    if (!code) {
      return jsonResponse({ success: false, error: "No authorization code received" }, 400);
    }

    const callbackUserId = state ? Number(state) : 0;
    if (!callbackUserId) {
      return jsonResponse({ success: false, error: "Invalid state parameter" }, 400);
    }

    const socialSettings = await getScopedSettings<SocialSettings>(env.DB, "social", callbackUserId);
    if (!socialSettings?.facebook_app_id || !socialSettings?.facebook_app_secret) {
      return jsonResponse({ success: false, error: "Facebook App credentials not configured" }, 400);
    }

    const baseUrl = env.FRONTEND_URL || "http://localhost:3000";
    const callbackUrl = socialSettings.facebook_callback_url || `${baseUrl}/api/oauth/facebook/callback`;

    const tokenRes = await fetch(`${FB_API_BASE}/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: socialSettings.facebook_app_id,
        client_secret: socialSettings.facebook_app_secret,
        redirect_uri: callbackUrl,
        code,
      }),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      return jsonResponse({ success: false, error: `Token exchange failed: ${errText}` }, 502);
    }

    const tokenData = await tokenRes.json() as { access_token?: string; expires_in?: number };
    if (!tokenData.access_token) {
      return jsonResponse({ success: false, error: "No access token received" }, 502);
    }

    const pagesRes = await fetch(`${FB_API_BASE}/me/accounts?access_token=${tokenData.access_token}&limit=100`);
    if (!pagesRes.ok) {
      return jsonResponse({ success: false, error: "Failed to fetch pages" }, 502);
    }

    const pagesData = await pagesRes.json() as { data?: Array<{ id: string; name: string; access_token: string }> };
    const pages = pagesData.data || [];

    if (pages.length === 0) {
      return jsonResponse({ success: false, error: "No Facebook pages found. Create a page first." }, 400);
    }

    const expiresAt = tokenData.expires_in
      ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
      : null;

    for (const page of pages) {
      try {
        await env.DB.prepare(`
          INSERT INTO social_accounts (user_id, platform, platform_account_id, account_name, access_token, token_expires_at)
          VALUES (?, 'facebook', ?, ?, ?, ?)
          ON CONFLICT(user_id, platform, platform_account_id) DO UPDATE SET
            access_token = excluded.access_token,
            token_expires_at = excluded.token_expires_at,
            account_name = excluded.account_name,
            updated_at = CURRENT_TIMESTAMP
        `).bind(callbackUserId, page.id, page.name, page.access_token, expiresAt).run();
      } catch (e) {
        console.error(`Failed to save Facebook page ${page.id}:`, e);
      }
    }

    const frontendUrl = env.FRONTEND_URL || "http://localhost:3000";
    return Response.redirect(`${frontendUrl}/settings?tab=social&connected=facebook`, 302);
  }

  if (!auth) {
    return jsonResponse({ success: false, error: "Unauthorized" }, 401);
  }

  const userId = auth.userId;

  if (path === "/api/oauth/facebook/url" && method === "GET") {
    const socialSettings = await getScopedSettings<SocialSettings>(env.DB, "social", userId);
    if (!socialSettings?.facebook_app_id || !socialSettings?.facebook_app_secret) {
      return jsonResponse({ success: false, error: "Facebook App ID and App Secret not configured. Settings me dalain." }, 400);
    }

    const baseUrl = env.FRONTEND_URL || "http://localhost:3000";
    const callbackUrl = socialSettings.facebook_callback_url || `${baseUrl}/api/oauth/facebook/callback`;

    const oauthUrl = new URL(FB_DIALOG);
    oauthUrl.searchParams.set("client_id", socialSettings.facebook_app_id);
    oauthUrl.searchParams.set("redirect_uri", callbackUrl);
    oauthUrl.searchParams.set("state", String(userId));
    oauthUrl.searchParams.set("scope", "pages_manage_posts,pages_read_engagement,pages_show_list,business_management");

    return jsonResponse({ success: true, data: { url: oauthUrl.toString(), callback_url: callbackUrl } });
  }

  if (path === "/api/oauth/facebook/accounts" && method === "GET") {
    const accounts = await env.DB.prepare(
      "SELECT * FROM social_accounts WHERE user_id = ? AND platform = 'facebook' ORDER BY account_name"
    ).bind(userId).all<SocialAccount>();

    return jsonResponse({ success: true, data: accounts.results || [] });
  }

  if (path.startsWith("/api/oauth/facebook/accounts/") && method === "DELETE") {
    const accountId = path.split("/").pop();
    if (!accountId || accountId === "facebook" || accountId === "accounts") {
      return jsonResponse({ success: false, error: "Account ID required" }, 400);
    }

    await env.DB.prepare(
      "DELETE FROM social_accounts WHERE id = ? AND user_id = ? AND platform = 'facebook'"
    ).bind(Number(accountId), userId).run();

    return jsonResponse({ success: true, message: "Facebook account disconnected" });
  }

  if (path === "/api/oauth/facebook/settings") {
    if (method === "GET") {
      const settings = await getScopedSettings<SocialSettings>(env.DB, "social", userId);
      return jsonResponse({
        success: true,
        data: {
          facebook_app_id: settings?.facebook_app_id || "",
          facebook_app_secret: settings?.facebook_app_secret ? "••••••••" : "",
        },
      });
    }

    if (method === "POST") {
      const body = await safeRequestJson<{ facebook_app_id?: string; facebook_app_secret?: string }>(request);
      if (!body) {
        return jsonResponse({ success: false, error: "Invalid JSON" }, 400);
      }

      await upsertScopedSettings(env.DB, SETTINGS_TABLES.social, userId, {
        facebook_app_id: body.facebook_app_id || null,
        facebook_app_secret: body.facebook_app_secret || null,
        facebook_callback_url: body.facebook_app_secret
          ? `${env.FRONTEND_URL || "http://localhost:3000"}/api/oauth/facebook/callback`
          : null,
      });

      return jsonResponse({ success: true, message: "Facebook settings saved" });
    }
  }

  return jsonResponse({ success: false, error: "OAuth route not found" }, 404);
}
