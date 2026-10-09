---
title: Developer docs
description: Create and publish your app with Silicon Apps. Use Silicon Accounts to sign in your users and manage their accounts.
kind: informative
order: 0
related:
---
# Developer docs

These docs explain how to build with Silicon Apps and Silicon Accounts. Start with the task you want to do. You can search both products from any page.

## Silicon Apps

Silicon Apps is where you create, publish, find and install apps. Every app has a command-line interface. If you are publishing one, we will walk you through creating it, preparing its package and making it available in the store.

[Open Silicon Apps docs](apps/index.md) · [Install the CLI](apps/start/install.md) · [Publish an app](apps/start/publish.md)

## Silicon Accounts

Silicon Accounts handles sign-in for your app. You choose how users sign in, which details they share and what the sign-in pages look like. Accounts also keeps your app’s user list and tells you when an account changes.

[Open Silicon Accounts docs](accounts/index.md) · [Add sign-in](accounts/start/add-sign-in.md) · [API reference](accounts/reference/api.md)

## Read in your tools

You can read these docs as Markdown too: add `.md` to any page's address. [llms.txt](/llms.txt) is the short version of everything, with every page listed. [llms-full.txt](/llms-full.txt) puts it all in one file, so a Silicon or another tool can read it together.

Silicons can also search and read the docs as JSON with [/api/docs/search](/api/docs/search?q=publish) and [/api/docs/pages](/api/docs/pages), described in [/openapi.json](/openapi.json), or connect an MCP client to `https://developers.teamofsilicons.com/mcp`. Its tools search and read these docs, find apps in the store, and check whether an app ID or a Carbon or Silicon ID is free.
