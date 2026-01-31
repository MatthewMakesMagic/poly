# Epic Extra: Scout - Real-Time Trading Monitor

**User Value:** I can watch live trading with plain-English explanations, building trust that the system does what I expect

## Overview

Scout is a friendly real-time monitoring agent that watches trading activity and explains what's happening in plain English. Scout surfaces issues for review without panic, confirms when things work as expected, and maintains a review queue for later analysis.

**Philosophy:** Scout embodies the "Silence = Trust" monitoring philosophy (FR24) but in a personified way - when things are working, Scout confirms briefly. When something's off, Scout explains clearly without jargon.

## Requirements

**Monitoring Requirements:**
- MR1: Scout can subscribe to real-time trade events (signals, entries, exits, alerts)
- MR2: Scout can display events in a terminal-friendly format within Claude Code
- MR3: Scout can translate technical events into plain-English explanations
- MR4: Scout can highlight issues requiring attention (warn/error level events)
- MR5: Scout can maintain a review queue of items needing follow-up
- MR6: Scout can connect to Railway deployments via log streaming

**Display Requirements:**
- DR1: Scout shows a status bar with active strategies, positions, and health
- DR2: Scout shows an event stream with timestamps and translations
- DR3: Scout shows a review queue section for items needing attention
- DR4: Scout uses ANSI colors for visual hierarchy (works in terminal)

**Integration Requirements:**
- IR1: Scout subscribes to trade-event module's EventEmitter (local mode)
- IR2: Scout parses Railway log stream (Railway mode)
- IR3: Scout is invokable via CLI command (`node cli/scout.js start`)

## Stories

### Story E.1: Scout Core Module & Terminal Renderer

As a **trader**,
I want **a terminal-based monitor that shows real-time trading activity**,
So that **I can see what's happening and build trust in the system**.

### Story E.2: Scout Railway Integration

As a **trader**,
I want **Scout to connect to my Railway deployment**,
So that **I can monitor live trading from my local terminal**.

### Story E.3: Scout Review Queue Persistence

As a **trader**,
I want **items needing review persisted for later analysis**,
So that **an analyst agent can investigate patterns**.

## Dependencies

- **Epic 5 (Monitoring & Diagnostics):** Scout uses trade_events and divergence detection
- **Story 5.5 (Silent Operation Mode):** Scout embodies this philosophy
- **trade-event module:** Scout subscribes to events from this module

## Technical Notes

Scout adds an EventEmitter to trade-event module for real-time subscriptions. Events are emitted when:
- `recordSignal()` is called → emits 'signal'
- `recordEntry()` is called → emits 'entry'
- `recordExit()` is called → emits 'exit'
- `recordAlert()` is called → emits 'alert'

Scout translates events using a personality-driven translator that converts technical data to ELI5 explanations.
