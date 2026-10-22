---
title: Send to Kindle
description: Deliver saved items to a Kindle device as EPUB.
---

uShelf can send a saved item to a Kindle as a reflowable EPUB of the saved source and its local images, without generated insights and without an Amazon cloud-library copy.

:::caution
This integration is unofficial. It uses Amazon's undocumented Send to Kindle protocol through [`cyrgim/stk`](https://github.com/cyrgim/stk), which Amazon may change or disable without notice. Use it only with an account you own.
:::

## Connect

```sh
ushelf kindle setup
ushelf kindle status
```

`setup` opens Amazon sign-in in your browser on this machine. After you paste the final redirect URL, the CLI registers a device credential with Amazon and uploads it to the current context's server, which stores it owner-readable in `secrets/kindle.json`. The credential is not kept on your machine and is never returned by the API or MCP tools. If the upload fails, the CLI deregisters the new credential from Amazon.

`status` shows the account, region, and registered devices with masked serials.

## Send

Use **Send to Kindle** in the reader, or ask your agent:

```text
Send the saved post about local-first software to my Kindle.
```

uShelf remembers the last device that received a delivery. If no valid preference exists and several devices are registered, the agent asks you to choose. Items must already be saved; the agent will not ingest a new URL as part of a delivery.

## Disconnect

```sh
ushelf kindle disconnect
```

This deregisters uShelf from Amazon and removes the server's credential. If Amazon has already invalidated the credential, remove it without deregistering:

```sh
ushelf kindle disconnect --skip-deregister --yes
```

## Read in the Kindle browser

You can also open the reader directly in the Kindle's built-in browser. The web app is built with a compatibility layer for older browser engines: polyfills plus a fallback bundle for browsers without JavaScript modules. Layout spacing can differ slightly from a current browser, and very old firmware whose browser predates Chrome 62-era JavaScript can show the library but not open items.
