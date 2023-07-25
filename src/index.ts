import { Context, Hono } from "hono";
import { cors } from "hono/cors";
import { poweredBy } from "hono/powered-by";
import * as auth from "./authorization";
import { Pattern, Playlist, User } from "./types";
import { Buffer } from "node:buffer";

type AppEnv = {
  bucket: R2Bucket;
  secretKey: string;
};

const app = new Hono<{ Bindings: AppEnv }>();

app.use("*", cors(), poweredBy());

app.post("/playlists", auth.authMiddleware(), async (c) => {
  const tokenPayload = auth.getPayload(c);
  if (!tokenPayload.user.is_admin) {
    return c.json({ error: "User not admin!" }, 403);
  }

  const newPlaylist = await c.req.json<Playlist>();
  const playlists = await getPlaylists(c);
  playlists.unshift(newPlaylist);

  const playlistsUnique = [
    ...new Map(playlists.map((playlist) => [playlist.uuid, playlist])).values(),
  ];

  const objectName = `playlists.json`;
  try {
    await c.env.bucket.put(objectName, JSON.stringify(playlistsUnique));
  } catch (e) {
    return c.json({ error: "R2 write error" }, 500);
  }
  return c.json({ uuid: newPlaylist.uuid });
});

app.get("/playlists", auth.authMiddleware(), async (c) => {
  const playlists = await getPlaylists(c);
  return c.json(playlists);
});

app.get("/playlists/:uuid", auth.authMiddleware(), async (c) => {
  const playlist_uuid = c.req.param("uuid");
  const playlists = await getPlaylists(c);
  const playlist = playlists.find((v) => v.uuid === playlist_uuid);

  if (!playlist) {
    return c.json({ error: "Not Found" }, 404);
  }

  c.header("Cache-Control", "max-age=31536000");
  return c.json(playlist);
});

app.post("/patterns", auth.authMiddleware(), async (c) => {
  interface PostPatternBody {
    patternData: string;
    pattern: Pattern;
    thumbData: string;
  }

  const tokenPayload = auth.getPayload(c);
  if (!tokenPayload.user.is_admin) {
    return c.json({ error: "User not admin!" }, 403);
  }

  const newPatternBody = await c.req.json<PostPatternBody>();

  try {
    const objectName = `patterns/${newPatternBody.pattern.uuid}`;
    await c.env.bucket.put(objectName, newPatternBody.patternData);
  } catch (e) {
    console.log(e);
    return c.json({ error: "Couldn't store pattern!" }, 500);
  }

  try {
    const objectName = `patterns/thumbs/${newPatternBody.pattern.uuid}.png`;
    const buf = Buffer.from(newPatternBody.thumbData, "base64");
    await c.env.bucket.put(objectName, buf);
  } catch (e) {
    console.log(e);
    return c.json({ error: "Couldn't store pattern thumbnail!" }, 500);
  }

  const patterns = await getPatterns(c);
  patterns.unshift(newPatternBody.pattern);

  const patternsUnique = [
    ...new Map(patterns.map((pattern) => [pattern.uuid, pattern])).values(),
  ];

  const objectName = `patterns.json`;
  try {
    await c.env.bucket.put(objectName, JSON.stringify(patternsUnique));
  } catch (e) {
    return c.json({ error: "R2 write error" }, 500);
  }
  return c.json({ uuid: newPatternBody.pattern.uuid });
});

app.get("/patterns", auth.authMiddleware(), async (c) => {
  const patterns = await getPatterns(c);
  return c.json(patterns);
});

app.get("/patterns/:uuid", auth.authMiddleware(), async (c) => {
  const pattern_uuid = c.req.param("uuid");
  const patterns = await getPatterns(c);
  const pattern = patterns.find((v) => v.uuid === pattern_uuid);

  if (!pattern) {
    return c.json({ error: "Not Found" }, 404);
  }

  c.header("Cache-Control", "max-age=31536000");
  return c.json(pattern);
});

app.get("/patterns/:uuid/data", auth.authMiddleware(), async (c) => {
  const pattern_uuid = c.req.param("uuid");
  const objectName = `patterns/${pattern_uuid}`;
  const object = await c.env.bucket.get(objectName);
  if (object === null) {
    return c.json({ error: "Not Found" }, 404);
  }

  const objectContent = await object.text();
  c.header("Content-Type", "text/plain");
  c.header("Cache-Control", "max-age=31536000");

  return c.body(objectContent);
});

app.get("/patterns/:uuid/thumb.png", auth.authMiddleware(), async (c) => {
  const pattern_uuid = c.req.param("uuid");
  const objectName = `patterns/thumbs/${pattern_uuid}.png`;
  const object = await c.env.bucket.get(objectName);
  if (object === null) {
    return c.json({ error: "Not Found" }, 404);
  }

  const objectContent = await object.arrayBuffer();
  c.header("Content-Type", "image/png");
  c.header("Cache-Control", "max-age=31536000");

  return c.body(objectContent);
});

app.post("/auth", async (c) => {
  interface AuthRequestBody {
    email: string;
    password: string;
  }

  const body = await c.req.json<AuthRequestBody>();

  if (!body.email || !body.password) {
    return c.json({ error: "Malformed request" }, 400);
  }

  const usersFile = await c.env.bucket.get("users.json");
  if (!usersFile) {
    return c.json({ error: "Couldn't retrieve users database!" }, 400);
  }
  const users = (await usersFile.json()) as User[];

  const thisUser = users.find((user) => {
    return user.email === body.email;
  });

  if (!thisUser || body.password !== thisUser.password) {
    return c.json({ error: "Invalid email or password" }, 401);
  }

  const tokenPayload = {
    user: thisUser,
  };

  const token = await auth.generateToken(tokenPayload, c.env.secretKey, "10y");

  return c.json({
    token,
  });
});

async function getPatterns(c: Context): Promise<Pattern[]> {
  const objectName = `patterns.json`;
  const object = await c.env.bucket.get(objectName);
  if (object === null) {
    throw new Error("Object not found");
  }
  const objectContent = await object.json();
  return objectContent as Pattern[];
}

async function getPlaylists(c: Context): Promise<Playlist[]> {
  const objectName = `playlists.json`;
  const object = await c.env.bucket.get(objectName);
  if (object === null) {
    throw new Error("Object not found");
  }
  const objectContent = await object.json();
  return objectContent as Playlist[];
}

app.notFound((c) => {
  return c.html(
    `
  <!DOCTYPE html>
<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->
<!--[if IE 7]>    <html class="no-js ie7 oldie" lang="en-US"> <![endif]-->
<!--[if IE 8]>    <html class="no-js ie8 oldie" lang="en-US"> <![endif]-->
<!--[if gt IE 8]><!-->
<html class="no-js" lang="en-US">
<!--<![endif]-->
<head>
    <meta charSet="utf-8"/>
    <meta http-equiv="refresh" content="30">
    <title>Page not found</title>
    <link rel="icon" type="image/png" href="https://workers.cloudflare.com/favicon.ico" sizes="48x48"/>
    <style>
    body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Oxygen", "Ubuntu", "Cantarell", "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif
    }

    body, html {
        margin: 0;
        padding: 0;
    }

    * {
        box-sizing: border-box;
    }

    .box {
        display: flex;
        flex-direction: column;
        justify-content: center;
        height: 100vh;
        background-color: #f8f8f8;
    }

    .content {
        margin: auto;
    }

    .content h1 {
        font-size: 32px;
        font-weight: 600;
        margin-bottom: 8px;
    }

    .content p {
        font-size: 16px;
        font-weight: 400;
        margin: 0;
    }

    .body {
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
    }

    .footer {
        display: flex;
        justify-content: flex-end;
        align-items: baseline;
        gap: 5px;
        margin: 32px;
    }
    </style>
</head>
<body>
    <div class="box">
        <div class="content">
            <div class="body">
                <svg width="315" height="310" viewBox="0 0 315 310" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="155.23" cy="154.582" r="154.582" fill="#D2EEF5"/>
                    <ellipse cx="157.99" cy="160.394" rx="96.3658" ry="96.579" fill="#E2F5FA"/>
                    <rect width="23.616" height="23.616" transform="matrix(1 0 0 -1 243.504 182.846)" fill="#E2F5FA"/>
                    <rect width="23.616" height="23.616" transform="matrix(1 0 0 -1 267.292 182.846)" fill="#F8FBFB"/>
                    <rect width="23.616" height="23.616" transform="matrix(1 0 0 -1 172.656 182.846)" fill="#C5EBF5"/>
                    <rect width="23.616" height="23.616" transform="matrix(1 0 0 -1 219.888 135.614)" fill="white"/>
                    <rect width="23.616" height="23.616" transform="matrix(1 0 0 -1 267.121 182.846)" fill="#F8FBFB"/>
                    <rect width="23.616" height="23.616" transform="matrix(1 0 0 -1 196.273 182.846)" fill="#C5EBF5"/>
                    <rect width="23.616" height="23.616" transform="matrix(1 0 0 -1 196.273 159.23)" fill="#C5EBF5"/>
                    <rect width="23.616" height="23.616" transform="matrix(1 0 0 -1 243.504 135.614)" fill="white"/>
                    <rect width="23.616" height="23.616" transform="matrix(1 0 0 -1 290.736 182.846)" fill="white"/>
                    <rect width="23.616" height="23.616" transform="matrix(1 0 0 -1 267.121 135.614)" fill="#E2F5FA"/>
                    <rect width="23.616" height="23.616" transform="matrix(1 0 0 -1 243.504 206.462)" fill="#C5EBF5"/>
                    <rect width="23.616" height="23.616" transform="matrix(1 0 0 -1 89.0504 241.447)" fill="#C5EBF5"/>
                    <rect width="24.3047" height="23.4519" transform="matrix(1 0 0 -1 42.0714 168.709)" fill="#C5EBF5"/>
                    <rect width="23.616" height="23.616" transform="matrix(1 0 0 -1 219.888 159.23)" fill="#E2F5FA"/>
                    <rect width="23.616" height="23.616" transform="matrix(1 0 0 -1 243.417 159.49)" fill="#E2F5FA"/>
                    <rect width="23.616" height="23.616" transform="matrix(1 0 0 -1 173.337 135.889)" fill="#E2F5FA"/>
                    <rect width="23.616" height="23.616" transform="matrix(1 0 0 -1 196.321 135.889)" fill="#C5EBF5"/>
                    <rect width="23.616" height="23.616" transform="matrix(1 0 0 -1 267.121 206.462)" fill="#F8FBFB"/>
                    <rect width="23.616" height="23.616" transform="matrix(1 0 0 -1 290.736 206.462)" fill="#C5EBF5"/>
                    <rect width="23.616" height="23.616" transform="matrix(1 0 0 -1 267.121 159.23)" fill="white"/>
                    <rect width="23.616" height="23.616" transform="matrix(1 0 0 -1 219.888 182.846)" fill="#C5EBF5"/>
                    <rect width="23.616" height="23.616" transform="matrix(1 0 0 -1 149.04 182.846)" fill="#C5EBF5"/>
                    <rect width="23.616" height="23.616" transform="matrix(1 0 0 -1 243.504 159.23)" fill="#F8FBFB"/>
                    <rect x="96.0818" y="122.05" width="23.5082" height="23.5082" fill="#E2F5FA"/>
                    <rect x="119.589" y="122.05" width="23.5082" height="23.5082" fill="#C5EBF5"/>
                    <rect x="96.0818" y="98.5417" width="23.5082" height="23.5082" fill="#C5EBF5"/>
                    <rect x="119.589" y="98.5417" width="23.5082" height="23.5082" fill="#C5EBF5"/>
                    <rect x="166.606" y="98.5417" width="23.5082" height="23.5082" fill="#C5EBF5"/>
                    <path d="M40.2497 156.99C41.0611 156.99 41.719 156.307 41.719 155.466C41.719 154.624 41.0611 153.942 40.2497 153.942C39.4382 153.942 38.7804 154.624 38.7804 155.466C38.7804 156.307 39.4382 156.99 40.2497 156.99Z" fill="#C5EBF5"/>
                    <path d="M45.3923 156.99C46.2038 156.99 46.8616 156.307 46.8616 155.466C46.8616 154.624 46.2038 153.941 45.3923 153.941C44.5808 153.941 43.923 154.624 43.923 155.466C43.923 156.307 44.5808 156.99 45.3923 156.99Z" fill="#C5EBF5"/>
                    <path d="M50.5349 156.99C51.3464 156.99 52.0042 156.307 52.0042 155.466C52.0042 154.624 51.3464 153.942 50.5349 153.942C49.7235 153.942 49.0656 154.624 49.0656 155.466C49.0656 156.307 49.7235 156.99 50.5349 156.99Z" fill="#C5EBF5"/>
                    <rect x="96.0818" y="75.7683" width="23.5082" height="23.5082" fill="#E2F5FA"/>
                    <rect x="25.5571" y="75.7684" width="23.5082" height="23.5082" fill="white"/>
                    <rect x="25.5571" y="122.05" width="23.5082" height="23.5082" fill="#E2F5FA"/>
                    <rect x="119.589" y="75.7683" width="23.5082" height="23.5082" fill="#C5EBF5"/>
                    <rect x="49.0656" y="75.7683" width="23.5082" height="23.5082" fill="white"/>
                    <rect x="49.0656" y="122.05" width="23.5082" height="23.5082" fill="#F8FBFB"/>
                    <rect x="143.098" y="75.7683" width="23.5082" height="23.5082" fill="white"/>
                    <rect x="166.486" y="75.7683" width="23.5082" height="23.5082" fill="#C5EBF5"/>
                    <rect x="72.5732" y="75.7683" width="23.5082" height="23.5082" fill="#F8FBFB"/>
                    <rect x="72.5732" y="122.05" width="23.5082" height="23.5082" fill="#E2F5FA"/>
                    <rect x="96.0818" y="52.2599" width="23.5082" height="23.5082" fill="white"/>
                    <rect x="25.5571" y="52.2599" width="23.5082" height="23.5082" fill="#C5EBF5"/>
                    <rect x="25.5571" y="98.5417" width="23.5082" height="23.5082" fill="#F8FBFB"/>
                    <rect x="119.589" y="52.2599" width="23.5082" height="23.5082" fill="white"/>
                    <rect x="49.0656" y="52.2599" width="23.5082" height="23.5082" fill="white"/>
                    <rect x="49.0656" y="98.5417" width="23.5082" height="23.5082" fill="#C5EBF5"/>
                    <rect x="143.098" y="52.2599" width="23.5082" height="23.5082" fill="#E2F5FA"/>
                    <rect x="72.5732" y="52.2599" width="23.5082" height="23.5082" fill="white"/>
                    <rect x="72.5732" y="98.5417" width="23.5082" height="23.5082" fill="#E2F5FA"/>
                    <path d="M242.411 99.3158H65.6067V220.084H242.411V99.3158Z" fill="#003682"/>
                    <rect x="65.6067" y="99.1472" width="177.781" height="18.0712" fill="#0055DC"/>
                    <rect x="67.1467" y="113.386" width="174.701" height="104.37" stroke="#0055DC" stroke-width="3.08012"/>
                    <path d="M76.5959 113.76C78.619 113.76 80.259 112.059 80.259 109.961C80.259 107.862 78.619 106.161 76.5959 106.161C74.5729 106.161 72.9329 107.862 72.9329 109.961C72.9329 112.059 74.5729 113.76 76.5959 113.76Z" fill="#FAAC42"/>
                    <path d="M88.8062 113.76C90.8292 113.76 92.4692 112.059 92.4692 109.961C92.4692 107.862 90.8292 106.161 88.8062 106.161C86.7831 106.161 85.1431 107.862 85.1431 109.961C85.1431 112.059 86.7831 113.76 88.8062 113.76Z" fill="#FAAC42"/>
                    <path d="M101.505 113.76C103.528 113.76 105.168 112.059 105.168 109.961C105.168 107.862 103.528 106.161 101.505 106.161C99.4817 106.161 97.8417 107.862 97.8417 109.961C97.8417 112.059 99.4817 113.76 101.505 113.76Z" fill="#FAAC42"/>
                    <path d="M266.501 93.8064H262.342V103.512H266.501V93.8064Z" fill="#FBAD41"/>
                    <path d="M277.937 105.669H268.58V109.982H277.937V105.669Z" fill="#FBAD41"/>
                    <path d="M266.501 112.139H262.342V121.844H266.501V112.139Z" fill="#FBAD41"/>
                    <path d="M260.263 105.669H250.907V109.982H260.263V105.669Z" fill="#FBAD41"/>
                    <path d="M47.8913 229.784H44.4295V239.018H47.8913V229.784Z" fill="#FBAD41"/>
                    <path d="M59.2656 241.583H50.3639V245.174H59.2656V241.583Z" fill="#FBAD41"/>
                    <path d="M47.8913 247.738H44.4295V256.972H47.8913V247.738Z" fill="#FBAD41"/>
                    <path d="M41.9566 241.583H33.0549V245.174H41.9566V241.583Z" fill="#FBAD41"/>
                    <path d="M244.039 259.097H242.302V263.154H244.039V259.097Z" fill="#FBAD41"/>
                    <path d="M248.815 264.056H244.907V265.859H248.815V264.056Z" fill="#FBAD41"/>
                    <path d="M244.039 266.76H242.302V270.817H244.039V266.76Z" fill="#FBAD41"/>
                    <path d="M241.434 264.056H237.527V265.859H241.434V264.056Z" fill="#FBAD41"/>
                    <rect x="117.55" y="156.426" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="124.322" y="156.426" width="6.77203" height="6.77203" fill="#E2F5FA"/>
                    <rect x="185.27" y="183.408" width="6.77203" height="6.77203" fill="#E2F5FA"/>
                    <rect x="110.778" y="183.408" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="124.322" y="183.408" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="137.866" y="183.408" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="151.41" y="183.408" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="158.182" y="183.408" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="171.726" y="183.408" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="117.55" y="183.408" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="131.094" y="183.408" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="144.638" y="183.408" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="192.042" y="183.408" width="6.77203" height="6.77203" fill="#E2F5FA"/>
                    <rect x="164.954" y="183.408" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="178.498" y="183.408" width="6.77203" height="6.77203" fill="#E2F5FA"/>
                    <rect x="178.265" y="176.604" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="103.772" y="176.604" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="117.316" y="176.604" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="130.86" y="176.604" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="144.404" y="176.604" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="151.176" y="176.604" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="164.72" y="176.604" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="110.544" y="176.604" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="124.088" y="176.604" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="137.632" y="176.604" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="185.036" y="176.604" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="191.809" y="176.604" width="6.77203" height="6.77203" fill="#E2F5FA"/>
                    <rect x="198.581" y="176.604" width="6.77203" height="6.77203" fill="#E2F5FA"/>
                    <rect x="157.948" y="176.604" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="171.492" y="176.604" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="178.265" y="169.8" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="103.772" y="169.8" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="117.316" y="169.8" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="130.86" y="169.8" width="6.77203" height="6.77203" fill="#E2F5FA"/>
                    <rect x="144.404" y="169.8" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="151.176" y="169.8" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="164.72" y="169.8" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="110.544" y="169.8" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="124.088" y="169.8" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="137.632" y="169.8" width="6.77203" height="6.77203" fill="#E2F5FA"/>
                    <rect x="185.036" y="169.8" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="191.809" y="169.8" width="6.77203" height="6.77203" fill="#E2F5FA"/>
                    <rect x="198.581" y="169.8" width="6.77203" height="6.77203" fill="#E2F5FA"/>
                    <rect x="157.948" y="169.8" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="171.492" y="169.8" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="185.037" y="162.995" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="110.545" y="162.995" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="124.089" y="162.995" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="137.633" y="162.995" width="6.77203" height="6.77203" fill="#E2F5FA"/>
                    <rect x="151.177" y="162.995" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="157.949" y="162.995" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="171.493" y="162.995" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="117.317" y="162.995" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="130.861" y="162.995" width="6.77203" height="6.77203" fill="#E2F5FA"/>
                    <rect x="144.405" y="162.995" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="191.809" y="162.995" width="6.77203" height="6.77203" fill="#E2F5FA"/>
                    <rect x="164.721" y="162.995" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="178.265" y="162.995" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="137.632" y="156.191" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="151.176" y="156.191" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="164.72" y="156.191" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="178.264" y="156.191" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="185.037" y="156.191" width="6.77203" height="6.77203" fill="#E2F5FA"/>
                    <rect x="144.404" y="156.191" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="157.948" y="156.191" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="171.492" y="156.191" width="6.77203" height="6.77203" fill="#E2F5FA"/>
                    <rect x="137.632" y="149.387" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="151.176" y="149.387" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="164.72" y="149.387" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="144.404" y="149.387" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="157.948" y="149.387" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="171.492" y="149.387" width="6.77203" height="6.77203" fill="#E2F5FA"/>
                    <rect x="151.176" y="142.582" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="164.72" y="142.582" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="144.404" y="142.582" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="157.948" y="142.582" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="171.492" y="142.582" width="6.77203" height="6.77203" fill="#E2F5FA"/>
                    <rect x="158.182" y="135.778" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="151.41" y="135.778" width="6.77203" height="6.77203" fill="white"/>
                    <rect x="164.954" y="135.778" width="6.77203" height="6.77203" fill="white"/>
                </svg>
                <h1>There is nothing here yet</h1>
                <p>
                    If you expect something to be here, it may take some time.
                    <br/>
                    Please check back again later.
                </p>
            </div>
        </div>
        <div class="footer">
            <div>Powered by</div>
            <svg width="100" height="34" viewBox="0 0 100 34" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M84.7738 21.2478L85.0181 20.4047C85.3094 19.4016 85.201 18.4745 84.7125 17.7932C84.2628 17.1658 83.5136 16.7963 82.6037 16.7533L65.3701 16.5357C65.3167 16.5346 65.2642 16.5211 65.217 16.496C65.1697 16.471 65.1291 16.4352 65.0983 16.3916C65.0681 16.3465 65.0489 16.2951 65.0421 16.2413C65.0354 16.1875 65.0413 16.1329 65.0595 16.0818C65.089 15.9975 65.1427 15.9238 65.2139 15.8696C65.285 15.8154 65.3705 15.7832 65.4598 15.777L82.8531 15.557C84.9164 15.4625 87.1502 13.7929 87.9323 11.7569L88.9242 9.17216C88.9648 9.06287 88.9741 8.94444 88.951 8.83018C87.8248 3.778 83.3035 0 77.8977 0C72.917 0 68.6878 3.20598 67.1709 7.66212C66.1458 6.89481 64.8679 6.54207 63.593 6.67454C61.2035 6.91117 59.2823 8.8298 59.0458 11.2132C58.9851 11.8083 59.0295 12.4094 59.1771 12.9893C55.2737 13.1028 52.1432 16.2921 52.1432 20.2126C52.1437 20.5626 52.1697 20.9121 52.2209 21.2583C52.2321 21.3383 52.2719 21.4115 52.3328 21.4647C52.3938 21.5179 52.4719 21.5475 52.5529 21.548L84.3692 21.5518C84.3722 21.552 84.3751 21.552 84.3781 21.5518C84.4681 21.5503 84.5552 21.5199 84.6264 21.4651C84.6977 21.4104 84.7494 21.3342 84.7738 21.2478Z" fill="#F6821F"/>
                <path d="M90.5148 9.35962C90.3551 9.35962 90.196 9.36362 90.0375 9.37162C90.012 9.37345 89.9869 9.37893 89.963 9.38789C89.9214 9.40205 89.8839 9.42604 89.8537 9.45781C89.8234 9.48958 89.8014 9.52818 89.7894 9.5703L89.1117 11.9045C88.8204 12.9076 88.9288 13.834 89.4177 14.5152C89.867 15.1434 90.6162 15.5121 91.5261 15.5551L95.1999 15.7751C95.2516 15.7768 95.3022 15.7905 95.3476 15.8151C95.393 15.8397 95.4321 15.8745 95.4617 15.9168C95.4922 15.9621 95.5115 16.0139 95.5183 16.0681C95.525 16.1222 95.5189 16.1772 95.5005 16.2286C95.4709 16.3127 95.4173 16.3863 95.3463 16.4404C95.2753 16.4946 95.19 16.5269 95.1009 16.5334L91.2837 16.7533C89.2111 16.8486 86.9777 18.5174 86.1963 20.5534L85.9206 21.2722C85.909 21.3023 85.9048 21.3346 85.9083 21.3666C85.9117 21.3986 85.9228 21.4294 85.9405 21.4563C85.9582 21.4831 85.9821 21.5055 86.0102 21.5213C86.0382 21.5372 86.0697 21.5462 86.1019 21.5476C86.1054 21.5476 86.1085 21.5476 86.112 21.5476H99.2469C99.3233 21.5483 99.3978 21.524 99.459 21.4785C99.5203 21.4329 99.5648 21.3687 99.586 21.2955C99.8188 20.4674 99.9364 19.6114 99.9355 18.7514C99.9339 13.5648 95.7168 9.35962 90.5148 9.35962Z" fill="#FBAD41"/>
                <path d="M11.1228 25.4294H13.3636V31.5342H17.2794V33.492H11.1228V25.4294Z" fill="#222222"/>
                <path d="M19.6002 29.4839V29.4611C19.6002 27.1458 21.4713 25.2679 23.9661 25.2679C26.4609 25.2679 28.3087 27.1226 28.3087 29.4378V29.4611C28.3087 31.7763 26.4372 33.6531 23.9432 33.6531C21.4492 33.6531 19.6002 31.7991 19.6002 29.4839ZM26.0217 29.4839V29.4611C26.0217 28.2992 25.1789 27.2837 23.9432 27.2837C22.7187 27.2837 21.8985 28.2744 21.8985 29.4378V29.4611C21.8985 30.6229 22.7416 31.638 23.9661 31.638C25.2018 31.638 26.0217 30.6473 26.0217 29.4839Z" fill="#222222"/>
                <path d="M31.0513 29.956V25.429H33.3266V29.9103C33.3266 31.0722 33.9158 31.6264 34.8164 31.6264C35.717 31.6264 36.3061 31.0966 36.3061 29.9677V25.429H38.5818V29.8972C38.5818 32.5005 37.0921 33.6403 34.7934 33.6403C32.4948 33.6403 31.0513 32.4784 31.0513 29.9549" fill="#222222"/>
                <path d="M42.011 25.4297H45.1295C48.0173 25.4297 49.6919 27.0881 49.6919 29.4146V29.4382C49.6919 31.7642 47.994 33.4923 45.0836 33.4923H42.011V25.4297ZM45.1644 31.5102C46.5046 31.5102 47.3932 30.7743 47.3932 29.4711V29.4483C47.3932 28.1586 46.5046 27.4096 45.1644 27.4096H44.2518V31.511L45.1644 31.5102Z" fill="#222222"/>
                <path d="M52.9486 25.4294H59.4163V27.3879H55.1894V28.7581H59.0124V30.6125H55.1894V33.492H52.9486V25.4294Z" fill="#222222"/>
                <path d="M62.5343 25.4294H64.7751V31.5342H68.6909V33.492H62.5343V25.4294Z" fill="#222222"/>
                <path d="M74.5461 25.3717H76.7054L80.1478 33.492H77.7454L77.1559 32.052H74.037L73.4599 33.492H71.1038L74.5461 25.3717ZM76.5093 30.3131L75.6083 28.0208L74.6956 30.3131H76.5093Z" fill="#222222"/>
                <path d="M83.0339 25.429H86.8569C88.0934 25.429 88.9474 25.752 89.4903 26.3047C89.9645 26.7655 90.2068 27.3891 90.2068 28.1826V28.2055C90.2068 29.4375 89.5466 30.2554 88.5435 30.6814L90.4725 33.4924H87.8845L86.2561 31.0501H85.2747V33.4924H83.0339V25.429ZM86.7532 29.2996C87.5155 29.2996 87.9548 28.9309 87.9548 28.3434V28.3205C87.9548 27.6869 87.4926 27.3647 86.7412 27.3647H85.2747V29.3011L86.7532 29.2996Z" fill="#222222"/>
                <path d="M93.4399 25.4294H99.9422V27.3302H95.6578V28.5505H99.5387V30.3131H95.6578V31.5919H100V33.492H93.4399V25.4294Z" fill="#222222"/>
                <path d="M6.21677 30.4289C5.90298 31.1364 5.24278 31.6376 4.36549 31.6376C3.14062 31.6376 2.29789 30.6241 2.29789 29.4607V29.4374C2.29789 28.2755 3.11771 27.2833 4.34219 27.2833C5.2653 27.2833 5.96823 27.8495 6.26493 28.6198H8.6269C8.24864 26.7008 6.55775 25.2682 4.36549 25.2682C1.87031 25.2682 0 27.1474 0 29.4607V29.4835C0 31.7987 1.8474 33.6538 4.34219 33.6538C6.47619 33.6538 8.14417 32.2759 8.58418 30.4293L6.21677 30.4289Z" fill="#222222"/>
            </svg>
        </div>
    </div>
</body>
</html>`,
    200
  );
});

export default app;
