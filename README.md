# FORGE

**Adversarial pitch prep for founders. Four AI agents. One coordination layer.**

> 🎥 [Watch the demo](https://drive.google.com/file/d/1awX_MroxFoT8gRvelH6wJzTUWaAP6ZPv/view?usp=sharing) · 🚀 [Live app](https://forge-chi-gold.vercel.app)

Built for the **Band of Agents Hackathon** — demonstrating real multi-agent collaboration where Band is the coordination layer, not a wrapper.

---

## What It Does

Founders walk into investor rooms unprepared for hostile questions — and don't know it until it's too late. FORGE puts them through a structured adversarial Q&A session before the real meeting. Four specialized AI agents attack the pitch simultaneously from different angles. After the session, a negotiated debrief ranks the five most dangerous weaknesses by deal-kill probability. Founders return after real meetings to log outcomes, and agents evolve their attacks in the next round.

---

## How Band Powers It

Band is not a notification channel — it is the shared state layer every agent writes to and reads from throughout the session. Remove Band and every agent loses all shared context: the session becomes four disconnected chatbots.

**What lives in Band:**
- Each agent's persistent question queue (priority-ordered, updated after every founder response)
- Structured annotation events — after each founder answer, all 4 agents post independent findings to Band before the next question is served
- `PASS_CONTROL` events — active agent hands off to the next highest-priority queued item
- Debrief nominations — each agent posts its top weakness nominations; Red Team reads all four and produces the final ranked list

**What flows through Band during a session:**
```
[FOUNDER]    → "We're targeting enterprise, so CAC is justified by LTV..."
[INVESTOR]   → Band: { type: "WEAK_POINT", topic: "CAC justification", confidence: "high" }
[RED_TEAM]   → Band: { type: "QUEUE_ADD",  question: "What's LTV to back that CAC up?" }
[COMPETITOR] → Band: { type: "WEAK_POINT", topic: "no moat vs incumbent pricing", confidence: "medium" }
[INVESTOR]   → Band: { type: "PASS_CONTROL" }
[COMPETITOR] → Founder: "Your nearest competitor charges 40% less — what's your retention differential?"
```

Agents never talk to each other. They leave structured traces in Band. The next agent reads those traces before forming its question. That is the coordination.

---

## Agent Architecture

| Agent | Attacks | LLM Provider | Why |
|---|---|---|---|
| **Investor** | Valuation, traction, financials, defensibility | AI/ML API | Heavy financial math, contradiction detection across session |
| **Red Team** | Assumptions, logic gaps, contradictions, execution risk | AI/ML API | Cross-session arbitration, final debrief ranking |
| **Competitor** | Differentiation, moat, competitive landscape | Featherless AI | Domain-specific probing, perspective-taking |
| **Customer** | Usability, willingness to pay, adoption friction | Featherless AI | Persona-based probing — no complex reasoning chains needed |

Provider assignment is deliberate, not arbitrary. AI/ML API handles reasoning-heavy roles (financial math, contradiction detection, ranked arbitration). Featherless open-source models handle probing and perspective roles where domain fluency matters more than reasoning depth.

**Stage-aware intensity.** The Stage field (Idea / Pre-revenue / Revenue / Growth) adjusts Investor agent attack intensity. An Idea-stage founder faces different scrutiny than a Revenue-stage founder. The system calibrates, it doesn't just interrogate.

---

## Session Flow

```
Founder submits intake form (funding ask, equity, traction, known risks)
        ↓
System creates Band room — all 4 agents join and initialize question queues
        ↓
Investor opens with valuation attack (mandatory — stakes always required)
        ↓
┌─────────────────────────────────────────────────────┐
│  Founder submits answer                             │
│        ↓                                           │
│  Next question served immediately from queue        │  ← < 100ms, no LLM wait
│        ↓                                           │
│  Background: all 4 agents evaluate answer in        │  ← parallel, silent
│  parallel and post annotations to Band             │
│        ↓                                           │
│  Queue updates take effect from question N+2        │  ← zero perceived latency
└─────────────────────────────────────────────────────┘
        ↓
All queues exhausted (or founder ends session)
        ↓
Each agent posts NOMINATION to Band
        ↓
Red Team reads all nominations → posts FINAL_DEBRIEF to Band
        ↓
Ranked debrief report delivered to founder
```

---

## Key Design Decisions

**Unasked questions count as evidence.** When the session ends, questions still in agent queues are flagged as the highest-risk blind spots. A weakness the founder never had to defend is more dangerous, not less. The debrief is a negotiated output — not a summary of what was asked.

**No agent-to-agent conversation.** Agents only respond to founder answers and structured Band events. No chat loops possible. One exception: if an agent detects a contradiction, it may post a single bounded interrupt — control returns to the founder immediately.

**Band is what the three systems divide responsibility around:**

| Decision | Who |
|---|---|
| Which agent asks next | Express server (queue priority logic) |
| Generating the question | AI/ML API or Featherless (LLM) |
| Delivering it to the founder | Band (POST /messages) |
| Notifying all agents of a response | Band (WebSocket push) |
| Posting annotation events | Express server (via Band POST /events) |
| Rehydrating session on reconnect | Band (/context endpoint) |

Remove any one of the three (Band, LLM, Express) and the session breaks.

---

## UI — Two Panels

**Left panel (Founder view)** — clean chat. Only agent questions and the final debrief. No coordination noise.

**Right panel (Agent Activity)** — live Band event feed. Annotation events, queue updates, `PASS_CONTROL` handoffs, debrief nominations — all visible in real time as they fire. This panel is always visible. It is the proof that Band is the coordination layer, not a claim.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React (Vite) |
| Backend | Express (Node.js) |
| Database | Neon (Postgres) |
| Agent coordination | Band |
| Speech-to-text | Deepgram (real-time streaming) |
| LLM — Investor + Red Team | AI/ML API (`gpt-4.1-nano`) |
| LLM — Competitor + Customer | Featherless AI (`deepseek-ai/DeepSeek-V3.1`) |
| Hosting | Vercel |

---

## Local Setup

```bash
# 1. Clone and install
git clone https://github.com/your-username/FORGE.git
cd FORGE
npm run install:all

# 2. Configure environment
cp server/.env.example server/.env
# Fill in: NEON_DATABASE_URL, BAND_API_KEY, AIML_API_KEY, FEATHERLESS_API_KEY, DEEPGRAM_API_KEY, JWT_SECRET

# 3. Run
npm run dev
# Client: http://localhost:5173
# Server: http://localhost:3001
```

---

## Hackathon

Built for the **Band of Agents Hackathon**.

**Challenge**: Build a multi-agent system where at least 3 agents collaborate through Band across planning, execution, review, decision-making, or task handoff — with Band as the actual coordination layer, not a thin wrapper.

**How FORGE qualifies**: Band holds every agent's question queue, receives structured annotation events from all four agents after each founder response, routes control handoffs between agents, and carries debrief nominations to Red Team arbitration. The session cannot run without Band — it is not a notification at the end of a workflow, it is the workflow.

Partner integrations: **AI/ML API** (Investor + Red Team + debrief arbitration) · **Featherless AI** (Competitor + Customer)
