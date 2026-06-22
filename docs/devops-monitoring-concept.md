# DevOps Monitoring Concept

> **Status:** Planungsartefakt / Machbarkeitsstudie (kein Implementierungs-Code)
> **Ziel:** Eine AWS-seitige Monitoring-Pipeline planen, die ausgewählte Signale
> in **SQS-Queues** sammelt, sodass ein **Composio-Tool** sie abrufen und der
> **Cursor IDE / dem Coding-Agenten** als Infrastruktur-Monitoring bereitstellen kann.
> **Account/Region (aus `docs/deployment.md`):** `423623826655`, `eu-central-1`.

---

## 1. Ziel & Kontext

Der Coding-Agent (Cursor Cloud Agent / IDE) soll den Zustand der AWS-Infrastruktur
„on demand" auswerten können. Statt den Agenten direkt mit breiten Lese-Rechten auf
alle AWS-APIs auszustatten, werden relevante Signale **vorab** in **SQS-Queues**
gepuffert. Der Agent (über ein Composio-Tool) **pollt** diese Queues – das ist
billiger, entkoppelt, ratenbegrenzt und sicherheitstechnisch eng scopebar.

Zu monitorende Signale (Anforderung):

1. **SNS-Topics per Wildcard** → EventBridge-Regel → SQS
2. **Geänderte AWS-Ressourcen** → SQS
3. **CloudWatch-Logs von Lambda** (Invocations, Failures, Ausführungslogs) → SQS

Zusätzliche Anforderung: **Tiering** – hochfrequente, „laute" Quellen (Lambda-
Invocations, SNS-Durchsatz) müssen von wichtigen, seltenen Signalen (Failures,
Ressourcenänderungen) **getrennt** sein, damit der Agent Wichtiges nicht im
Rauschen verliert.

---

## 2. Anforderungen → Machbarkeit (Kurzüberblick)

| # | Anforderung | Nativ möglich? | Empfohlener Weg | Aufwand |
|---|---|---|---|---|
| 1 | SNS-Topics per Wildcard → EventBridge → SQS | **Teilweise** | SNS in EventBridge bridgen (Lambda/Pipe) **oder** Producer direkt auf EventBridge; dann eine Wildcard-Regel → SQS | mittel |
| 2 | Geänderte Ressourcen → SQS | **Ja** | AWS Config + CloudTrail → EventBridge → SQS (Wildcard-Regel) | mittel |
| 3 | Lambda-Logs/Failures → SQS | **Ja, mit Adapter** | CloudWatch Logs Subscription Filter → Forwarder-Lambda → SQS; Failures zusätzlich via Lambda-Destinations/Alarm | mittel |
| – | Tiering (laut vs. wichtig) | **Ja** | Zwei (oder drei) SQS-Queues + EventBridge-Regeln/Filter zur Klassifizierung | gering |
| – | Composio → SQS → Cursor | **Ja, aber Connector-Entscheidung nötig** | Composio Custom Tool / Remote-Bash mit AWS CLI gegen `ReceiveMessage` (kein fertiger nativer SQS-Connector vorhanden) | mittel |

**Gesamtfazit: machbar.** Es gibt keinen Blocker. Die einzige „Achtung"-Stelle ist,
dass **SNS keine native EventBridge-Quelle** ist (Anforderung 1) und dass
**CloudWatch Logs nicht direkt nach SQS** liefern können (Anforderung 3) – beides
wird über kleine Adapter gelöst (siehe unten).

---

## 3. Ziel-Architektur (Überblick)

```
                          QUELLEN                          ROUTING                TIERING (SQS)
                                                                            ┌────────────────────────┐
 (1) SNS-Topics ──(Bridge: Lambda PutEvents)──┐                            │  q-monitoring-critical   │
                                              │                            │  (low volume / wichtig)  │
 (2) AWS Config (Config-Item-Changes) ────────┤                            │  - Failures              │
     CloudTrail (Create/Update/Delete) ───────┼──▶ EventBridge ──(Regeln + ┤  - Ressourcenänderungen  │
                                              │     Custom Bus)   Pattern/  │  - kritische SNS-Events  │
 (3) Lambda Failures (Destinations/Alarm) ────┤                   Wildcard)└────────────┬─────────────┘
                                              │                                         │
 (3) Lambda Exec-Logs (CW Logs Subscription ──┼──▶ Forwarder-Lambda ───────┐            │
      Filter) ── invocations/INFO             │                            │            │
                                              │                            ▼            │
 (1) SNS High-Volume-Events ──────────────────┘            ┌────────────────────────┐  │
                                                           │  q-monitoring-verbose    │  │
                                                           │  (high volume / laut)    │  │
                                                           │  - Invocation-Logs       │  │
                                                           │  - Routine-SNS-Events    │  │
                                                           └────────────┬─────────────┘  │
                                                                        │                │
                                  Jede Queue hat eine ──▶ q-*-dlq (Dead-Letter-Queue)    │
                                                                        │                │
                                                                        ▼                ▼
                                              Composio Tool (ReceiveMessage/DeleteMessage, scoped IAM)
                                                                        │
                                                                        ▼
                                                            Cursor IDE / Coding-Agent
```

**Designprinzipien:**

- **EventBridge ist der zentrale Hub** für Klassifizierung/Routing/Wildcards.
  CloudWatch-Log-Invocations gehen aus Volumengründen über einen direkten
  Forwarder-Pfad (nicht zwingend über EventBridge), um Kosten zu sparen.
- **Mindestens zwei SQS-Queues** (`critical`, `verbose`), je mit **DLQ**.
- **Standard-Queues** (kein FIFO): Monitoring braucht Durchsatz, keine strikte
  Ordnung. Reihenfolge wäre bei Multi-Source-Aggregation ohnehin nicht sinnvoll.

---

## 4. Machbarkeit je Anforderung (Detail)

### 4.1 SNS-Topics per Wildcard → EventBridge → SQS

**Harte Randbedingung:** SNS ist **kein** natives EventBridge-Subscription-Ziel,
und SNS ist **keine** native EventBridge-Quelle. „Wildcard-Subscriptions" gibt es
in SNS nicht. Wildcard-Matching ist eine **EventBridge-Funktion** (`prefix`,
`wildcard` in Event-Patterns) und greift nur auf Events, die bereits auf dem Bus
liegen.

**Lösungswege:**

- **Weg A (sauber, empfohlen, falls beeinflussbar):** Producer publishen direkt
  auf den EventBridge-Bus mit einer `source`-Namenskonvention (z. B.
  `myapp.<domain>`). Eine einzige Regel matched per Wildcard und routet nach SQS:

  ```json
  { "source": [{ "prefix": "myapp." }] }
  ```

- **Weg B (Bestands-SNS-Topics behalten):** Pro Topic eine Bridge zu EventBridge:
  - **SNS → Lambda → `events:PutEvents`** (Lambda als dünner Adapter, setzt
    `detail.topicArn`), **oder**
  - **SNS → SQS → EventBridge Pipe → Bus** (Pipe nutzt SQS als Quelle).

  Danach Wildcard-Regel auf dem Bus, z. B.:

  ```json
  { "detail": { "topicArn": [{ "wildcard": "arn:aws:sns:eu-central-1:423623826655:myapp-*" }] } }
  ```

- **Weg C (Auto-Subscribe, „Wildcard-Verhalten" ohne EventBridge):**
  EventBridge-Regel auf CloudTrail-`CreateTopic` → Lambda subscribet neue,
  zum Namensmuster passende Topics automatisch an die Ziel-Queue. Ersetzt
  manuelles Subscriben, bleibt aber technisch SNS→SQS.

**Empfehlung:** Weg A, wenn die Publisher anpassbar sind. Sonst Weg B mit einer
generischen Bridge-Lambda (ein Adapter für alle relevanten Topics) plus einer
Wildcard-Regel. Klassifizierung kritisch vs. verbose über zwei Regeln mit
unterschiedlichen Patterns (z. B. `*-alarm`/`*-error` → critical, Rest → verbose).

### 4.2 Geänderte AWS-Ressourcen → SQS

**Nativ gut machbar.** Zwei sich ergänzende Quellen:

- **AWS Config** – liefert **Configuration Item Change**-Events (was hat sich an
  einer Ressource konkret geändert, inkl. Diff). Config emittiert nach EventBridge
  (`source: "aws.config"`, `detail-type: "Config Configuration Item Change"`).
- **CloudTrail** – liefert die auslösende **API-Aktion** (`Create*`/`Update*`/
  `Delete*`, wer/wann). Management-Events erscheinen als EventBridge-Events
  (`detail-type: "AWS API Call via CloudTrail"`).

**Routing:** Diese Events sind **selten und wichtig** → Ziel-Queue
`q-monitoring-critical`. Beispiel-Pattern (alle mutierenden API-Calls):

```json
{
  "detail": {
    "eventName": [{ "prefix": "Create" }, { "prefix": "Update" },
                  { "prefix": "Delete" }, { "prefix": "Put" }]
  }
}
```

**Hinweise/Kosten:** AWS Config kostet pro aufgezeichnetem Configuration Item;
sinnvoll den **Recording-Scope** auf relevante Ressourcentypen (S3, Lambda,
IAM-Rollen, CloudFront, SageMaker) beschränken. CloudTrail-Management-Events sind
im ersten Trail kostenfrei; Data-Events (z. B. S3-Objektzugriffe) wären teuer und
sind hier **nicht** nötig.

### 4.3 CloudWatch-Logs von Lambda (Invocations, Failures, Exec-Logs) → SQS

**Harte Randbedingung:** CloudWatch Logs **Subscription Filter** können **nicht
direkt** nach SQS liefern. Erlaubte Ziele: **Lambda, Kinesis Data Streams,
Kinesis Data Firehose**. SQS ist kein direktes Ziel → ein **Forwarder** ist nötig.

**Lösung:**

- **Subscription Filter** je Log-Gruppe (`/aws/lambda/<fn>`) mit **Filter-Pattern**:
  - **Failures:** Pattern wie `?ERROR ?Exception ?"Task timed out" ?"Unhandled"`
    → Forwarder-Lambda → `q-monitoring-critical`.
  - **Invocations/INFO (laut):** breiteres/leeres Pattern → Forwarder-Lambda →
    `q-monitoring-verbose` (optional Sampling, siehe unten).
- **Forwarder-Lambda:** dekomprimiert die CloudWatch-Logs-Payload (gzip,
  base64), normalisiert zu kompaktem JSON und ruft `sqs:SendMessage(Batch)` auf.
- **Failures zusätzlich präziser erfassen** (unabhängig von Log-Parsing):
  - **Lambda Destinations** (`onFailure` → SQS/SNS/EventBridge) für **asynchrone**
    Invocations – strukturierter als Log-Scraping.
  - **Dead-Letter-Queue** der Funktion für nicht zustellbare async-Events.
  - **CloudWatch-Alarm** auf der `Errors`-Metrik (+ `Throttles`, `Duration` p99)
    → EventBridge/SNS → `q-monitoring-critical` (gut für Schwellwert-Alerts statt
    Einzelevents).

**Empfehlung Tiering:** „Echte" Fehlersignale (Destinations/Alarme + ERROR-Logs)
→ critical. Normale Ausführungslogs → verbose, dort **aggressiv filtern/samplen**,
weil Invocation-Logs das mit Abstand größte Volumen erzeugen.

---

## 5. Queue-Design & Tiering

| Queue | Inhalt | Volumen | Polling-Strategie des Agenten |
|---|---|---|---|
| `q-monitoring-critical` | Failures, Ressourcenänderungen, kritische SNS-Events, Alarme | niedrig | häufig/eifrig (long polling), priorisiert auswerten |
| `q-monitoring-verbose` | Lambda-Invocation-Logs, Routine-SNS-Events | hoch | seltener/sampling, on-demand bei Bedarf |
| `q-monitoring-*-dlq` | Nicht verarbeitbare Nachrichten je Queue | sehr niedrig | nur bei Diagnose |

**Konfigurationsempfehlungen:**

- **Typ:** SQS **Standard** (Durchsatz vor Ordnung).
- **Retention:** bis zu 14 Tage (Default 4 Tage) – erlaubt dem Agenten, auch
  ältere Vorfälle nachzulesen.
- **Long Polling:** `ReceiveMessageWaitTimeSeconds = 20` (weniger leere Polls,
  geringere Kosten).
- **DLQ + `maxReceiveCount`** (z. B. 5) je Queue.
- **Visibility Timeout:** an die Agent-Verarbeitungszeit anpassen (z. B. 60 s).
- **Verschlüsselung:** SSE-SQS (oder SSE-KMS, falls Logs sensibel sind).

**Optionale 3. Stufe:** `q-monitoring-audit` (nur Ressourcenänderungen/CloudTrail)
trennen, falls Compliance-Auswertung getrennt vom Failure-Stream gewünscht ist.

---

## 6. Composio → Cursor-Integration

**Befund (geprüft):** In der aktuellen Composio-Umgebung gibt es **keinen fertigen,
nativen AWS-SQS-`ReceiveMessage`-Connector** (Tool-Suche liefert nur unpassende
Toolkits). Daraus folgen drei realistische Optionen für die Abrufschicht:

1. **Composio Custom Tool / HTTP-Action gegen einen eigenen Endpunkt**
   (empfohlen, wenn ein dünnes Backend okay ist): Eine kleine **API
   (Lambda + Function URL / API Gateway)** kapselt `ReceiveMessage` +
   `DeleteMessage` und gibt normalisiertes JSON zurück. Composio ruft diese
   HTTP-Action auf. Vorteil: stabile, typisierte Schnittstelle, Auth über
   API-Key/IAM, kein direktes AWS-Credential im Tool nötig.
2. **Composio Remote-Bash/Workbench mit AWS CLI:** Das Tool führt
   `aws sqs receive-message ...` mit scoped, read-/consume-only Credentials aus.
   Schnell aufgesetzt, aber gröber (CLI-Output statt sauberem Schema).
3. **Nativer AWS-Connector, falls im Composio-Workspace verfügbar/aktivierbar:**
   vor Umsetzung via `COMPOSIO_MANAGE_CONNECTIONS` / Tool-Suche verifizieren;
   wenn vorhanden, vorzuziehen.

**Empfehlung:** Option 1 (dünne SQS-Reader-API) – sie passt zur bestehenden
OIDC-/Lambda-Landschaft, liefert ein sauberes Schema für den Agenten und hält
AWS-Credentials serverseitig.

**Konsum-Semantik:** Der Agent sollte Nachrichten nach erfolgreicher Auswertung
**löschen** (`DeleteMessage`), sonst tauchen sie nach Visibility Timeout erneut
auf. Für „nur lesen, nicht konsumieren" kann ein Peek-Modus (kein Delete) mit
kurzem Visibility Timeout genutzt werden.

---

## 7. IAM & Sicherheit

- **Producer-Rechte (Pipeline):** Forwarder-/Bridge-Lambdas brauchen
  `sqs:SendMessage` nur auf die jeweilige Ziel-Queue; EventBridge-Regeln brauchen
  eine **resource-based Policy** der Queue mit Principal `events.amazonaws.com`
  (Condition `aws:SourceArn` = Regel-ARN).
- **Consumer-Rechte (Composio/Agent):** **eigener, eng gescopeter** Principal,
  **nur** `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:GetQueueAttributes`
  auf die Monitoring-Queues. **Keine** breiten Lese-Rechte auf andere AWS-APIs.
- **Trennung von der Deploy-Rolle:** Die bestehende OIDC-Deploy-Rolle
  (`docs/deployment.md`) **nicht** wiederverwenden. Neue, dedizierte Rollen/Policy.
- **Least Privilege bei Quellen:** AWS Config Recording-Scope und
  Subscription-Filter-Pattern eng halten (Kosten + Datensparsamkeit).
- **Verschlüsselung & PII:** Lambda-Logs können sensible Daten enthalten →
  SSE-KMS auf den Queues erwägen und im Forwarder ggf. Felder maskieren.

---

## 8. Limits & Stolperfallen

- **SQS-Nachrichtengröße: max. 256 KB.** Log-Batches aus Subscription Filtern
  können größer sein → im Forwarder **splitten** oder **Claim-Check-Pattern**
  (großen Payload in S3, nur Pointer in SQS).
- **CloudWatch Logs → SQS nicht direkt** (siehe 4.3): Forwarder zwingend.
- **SNS ≠ EventBridge-Quelle** (siehe 4.1): Bridge zwingend, falls EventBridge-
  Wildcards über SNS gewünscht.
- **EventBridge: keine Ordnungsgarantie, kein FIFO.** Für Monitoring ok.
- **Kosten-Treiber:** Lambda-Invocation-Logs (Volumen!), AWS Config (pro CI),
  CloudTrail Data-Events (vermeiden). Gegenmaßnahmen: Filter-Pattern, Sampling,
  Config-Scope, verbose-Queue mit kurzer Retention.
- **Idempotenz/Dubletten:** Standard-SQS ist *at-least-once* → Agent muss
  doppelte Nachrichten tolerieren (z. B. Dedup über Event-ID).
- **Polling-Last:** Long Polling nutzen; verbose-Queue nicht dauer-pollen.

---

## 9. Annahmen & offene Entscheidungen

**Annahmen:**

- Region `eu-central-1`, Account `423623826655` (aus `docs/deployment.md`).
- Es existieren bereits Lambda-Funktionen (Pre-Annotation/Deploy-Kontext) und
  SNS-Topics, die monitort werden sollen.
- IaC erfolgt analog zum bestehenden Stil (GitHub Actions + OIDC).

**Zu entscheiden (vor Umsetzung):**

1. **SNS-Pfad:** Weg A (direkt auf EventBridge publishen) vs. Weg B (Bridge für
   Bestands-Topics) vs. Weg C (Auto-Subscribe)?
2. **Composio-Connector:** dünne SQS-Reader-API (Option 1) vs. Remote-Bash+CLI
   (Option 2) vs. nativer Connector (Option 3)?
3. **Failure-Quelle:** Log-Pattern (ERROR) und/oder Lambda-Destinations und/oder
   CloudWatch-Alarme – welche Kombination?
4. **Anzahl Queues:** 2 (critical/verbose) oder 3 (+ audit)?
5. **IaC-Tooling:** CloudFormation vs. Terraform?
6. **Namensmuster** für SNS-Wildcard und Klassifizierung (critical vs. verbose).

---

## 10. Umsetzungsschritte (phasiert)

1. **Fundament:** SQS-Queues (`critical`, `verbose`) + DLQs + Queue-Policies anlegen.
2. **Ressourcenänderungen (Anf. 2):** AWS Config (scoped) + CloudTrail-Trail,
   EventBridge-Regeln → `critical`. *(Schnellster Mehrwert, rein nativ.)*
3. **Lambda-Failures (Teil Anf. 3):** Lambda-Destinations/Alarme → `critical`.
4. **Lambda-Logs (Teil Anf. 3):** Subscription Filter + Forwarder-Lambda →
   `verbose` (Failures-Pattern → `critical`).
5. **SNS-Wildcard (Anf. 1):** gewählten Weg (A/B/C) umsetzen, EventBridge-
   Wildcard-Regel(n) → Queues.
6. **Composio-Abrufschicht:** gewählte Option umsetzen + scoped Consumer-IAM.
7. **Agenten-Anbindung:** Tool in Cursor verfügbar machen, Polling-/Delete-Logik,
   Dedup, Priorisierung critical vor verbose.
8. **Härtung:** Kosten-Review, Sampling justieren, KMS, DLQ-Alarme.

---

## 11. Nächste Artefakte (optional)

Nach Klärung der offenen Entscheidungen aus §9 können folgende konkreten
Artefakte erstellt werden:

- IaC-Stack (CloudFormation/Terraform) für Queues, Regeln, Config, Forwarder.
- Forwarder-Lambda (CloudWatch-Logs → SQS, inkl. Claim-Check).
- SQS-Reader-API + Composio-Tool-Definition.
- Erweiterung der IAM-Policies in `docs/deployment.md`-Stil.

> Dieses Dokument hält ausschließlich **Machbarkeit und Plan** fest. Es nimmt noch
> keine Implementierungs- oder Tooling-Entscheidungen vorweg (siehe §9).
