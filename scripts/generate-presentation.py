import os
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN
from pptx.enum.shapes import MSO_SHAPE

def create_deck(output_path):
    prs = Presentation()
    # Standard 16:9 widescreen
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    blank_layout = prs.slide_layouts[6]

    # Clean, High-Contrast Modern Theme
    BG_DARK = RGBColor(0x11, 0x12, 0x16)       # Discord Dark #111216
    CARD_BG = RGBColor(0x1c, 0x1e, 0x24)       # Clean card container
    CARD_BORDER = RGBColor(0x2f, 0x33, 0x40)   # Subtle outline
    ACCENT_BLUE = RGBColor(0x58, 0x65, 0xf2)   # Blurple (Primary Highlight)
    ACCENT_GREEN = RGBColor(0x23, 0xa5, 0x5a)  # Emerald (Success/Feature)
    ACCENT_AMBER = RGBColor(0xf0, 0xb2, 0x32)  # Warning/Key Note
    TEXT_MAIN = RGBColor(0xf0, 0xf2, 0xf5)     # Bright readable text
    TEXT_MUTED = RGBColor(0x9a, 0xa2, 0xb0)    # Soft secondary text
    TEXT_CODE = RGBColor(0x72, 0xf1, 0xb8)     # Mint code highlight

    def set_slide_bg(slide):
        bg = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, prs.slide_width, prs.slide_height)
        bg.fill.solid()
        bg.fill.fore_color.rgb = BG_DARK
        bg.line.fill.background()
        return bg

    def add_header(slide, title, category="System Design Project · Real-Time Pub/Sub"):
        # Category Tracker
        tb_cat = slide.shapes.add_textbox(Inches(0.8), Inches(0.4), Inches(11.7), Inches(0.3))
        p_cat = tb_cat.text_frame.paragraphs[0]
        p_cat.text = category.upper()
        p_cat.font.size = Pt(11)
        p_cat.font.bold = True
        p_cat.font.color.rgb = ACCENT_BLUE

        # Big, Clear Slide Title
        tb = slide.shapes.add_textbox(Inches(0.8), Inches(0.68), Inches(11.7), Inches(0.65))
        p = tb.text_frame.paragraphs[0]
        p.text = title
        p.font.size = Pt(24)
        p.font.bold = True
        p.font.color.rgb = TEXT_MAIN

    def add_card(slide, left, top, width, height, title="", title_color=ACCENT_BLUE, border_color=CARD_BORDER):
        card = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, left, top, width, height)
        card.fill.solid()
        card.fill.fore_color.rgb = CARD_BG
        card.line.color.rgb = border_color
        card.line.width = Pt(1.5)

        if title:
            tb = slide.shapes.add_textbox(left + Inches(0.25), top + Inches(0.18), width - Inches(0.5), Inches(0.45))
            p = tb.text_frame.paragraphs[0]
            p.text = title
            p.font.size = Pt(14)
            p.font.bold = True
            p.font.color.rgb = title_color
        return card

    # ==========================================
    # SLIDE 1: Title Slide (Matches Outline Template)
    # ==========================================
    s1 = prs.slides.add_slide(blank_layout)
    set_slide_bg(s1)

    # Project Pill
    badge = s1.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(0.8), Inches(0.9), Inches(4.5), Inches(0.42))
    badge.fill.solid()
    badge.fill.fore_color.rgb = RGBColor(0x23, 0x27, 0x3d)
    badge.line.color.rgb = ACCENT_BLUE
    p_b = badge.text_frame.paragraphs[0]
    p_b.text = "SYSTEM DESIGN PROJECT : REAL-TIME PUB/SUB"
    p_b.font.size = Pt(11)
    p_b.font.bold = True
    p_b.font.color.rgb = RGBColor(0x8c, 0x97, 0xff)
    p_b.alignment = PP_ALIGN.CENTER

    # Title & Subtitle
    tb_title = s1.shapes.add_textbox(Inches(0.8), Inches(1.45), Inches(11.7), Inches(1.8))
    tf_t = tb_title.text_frame
    tf_t.word_wrap = True
    p = tf_t.paragraphs[0]
    p.text = "STATEFUL WEBSOCKET GATEWAY CLUSTER"
    p.font.size = Pt(36)
    p.font.bold = True
    p.font.color.rgb = TEXT_MAIN

    p2 = tf_t.add_paragraph()
    p2.text = "WITH REDIS BACKPLANE  (Mini Discord Demo)"
    p2.font.size = Pt(24)
    p2.font.bold = True
    p2.font.color.rgb = ACCENT_BLUE

    # Clean Visual Architecture Block: NLB -> gw-1/2/3 -> REDIS
    arch_box = s1.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(0.8), Inches(3.3), Inches(11.733), Inches(2.2))
    arch_box.fill.solid()
    arch_box.fill.fore_color.rgb = CARD_BG
    arch_box.line.color.rgb = CARD_BORDER

    # Step Boxes
    steps = [
        ("L4 NLB", "Nginx / AWS NLB\n(Port 8080)", Inches(1.3), Inches(3.8)),
        ("gw-1", "Gateway Node 1\n(Stateful WS)", Inches(4.3), Inches(3.5)),
        ("gw-2", "Gateway Node 2\n(Stateful WS)", Inches(4.3), Inches(4.15)),
        ("gw-3", "Gateway Node 3\n(Stateful WS)", Inches(4.3), Inches(4.8)),
        ("REDIS", "Pub/Sub + Streams\nAtomic Lua Linearizer", Inches(7.5), Inches(3.8)),
        ("AWS CLOUD", "CloudWatch · DynamoDB\nS3 · SNS Telemetry", Inches(10.1), Inches(3.8)),
    ]
    # Draw central nodes
    for name, desc, x, y in [
        ("L4 NLB", "Nginx / AWS NLB (Flow-Hash)", Inches(1.4), Inches(3.85)),
        ("GATEWAYS", "gw-1 · gw-2 · gw-3 (3 Replicas)", Inches(4.4), Inches(3.85)),
        ("REDIS BACKPLANE", "Pub/Sub + Durable Streams", Inches(7.4), Inches(3.85)),
        ("AWS SERVICES", "CloudWatch, DynamoDB, S3, SNS", Inches(10.0), Inches(3.85)),
    ]:
        box = s1.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, x, y, Inches(2.2), Inches(1.1))
        box.fill.solid()
        box.fill.fore_color.rgb = RGBColor(0x23, 0x27, 0x33)
        box.line.color.rgb = ACCENT_BLUE
        tf_b = box.text_frame
        tf_b.word_wrap = True
        p = tf_b.paragraphs[0]
        p.text = name
        p.font.size = Pt(11)
        p.font.bold = True
        p.font.color.rgb = TEXT_MAIN
        p.alignment = PP_ALIGN.CENTER
        p2 = tf_b.add_paragraph()
        p2.text = desc
        p2.font.size = Pt(9)
        p2.font.color.rgb = TEXT_MUTED
        p2.alignment = PP_ALIGN.CENTER

    # Presenter Details Footer
    tb_foot = s1.shapes.add_textbox(Inches(0.8), Inches(5.8), Inches(11.7), Inches(1.1))
    tf_f = tb_foot.text_frame
    p = tf_f.paragraphs[0]
    p.text = "Team Names: [Student Names]   ·   Division: [Division]   ·   Roll Nos: [Roll Numbers]"
    p.font.size = Pt(14)
    p.font.bold = True
    p.font.color.rgb = ACCENT_AMBER
    p2 = tf_f.add_paragraph()
    p2.text = "Guarantees: Per-Room Total Order · Zero Loss / No Duplicates · Fault-Tolerant Failover"
    p2.font.size = Pt(11.5)
    p2.font.color.rgb = ACCENT_GREEN

    # ==========================================
    # SLIDE 2: INTRODUCTION, PROBLEM & OBJECTIVES
    # ==========================================
    s2 = prs.slides.add_slide(blank_layout)
    set_slide_bg(s2)
    add_header(s2, "Introduction, Problem Statement & Objectives")

    col_w = Inches(3.7)
    gap = Inches(0.3)
    top_pos = Inches(1.4)
    card_h = Inches(5.4)

    # 1. Introduction
    add_card(s2, Inches(0.8), top_pos, col_w, card_h, "1. Introduction", ACCENT_BLUE)
    tb = s2.shapes.add_textbox(Inches(1.0), top_pos + Inches(0.6), col_w - Inches(0.4), card_h - Inches(0.8))
    tf = tb.text_frame
    tf.word_wrap = True
    intro_pts = [
        "Stateful WebSocket gateway cluster designed for a Discord-style chat application.",
        "Built on two core primitives: Layer 4 Network Load Balancer (NLB) + Redis cluster.",
        "Guarantees per-room message order, zero loss, and zero duplicates even through server crashes.",
        "Status: 100% fully implemented, all 20+ tests passing, complete with local benchmarks & live UI.",
    ]
    for pt in intro_pts:
        p = tf.add_paragraph() if tf.paragraphs[0].text else tf.paragraphs[0]
        p.text = f"• {pt}"
        p.font.size = Pt(11.5)
        p.font.color.rgb = TEXT_MAIN
        p.space_after = Pt(12)

    # 2. Problem
    add_card(s2, Inches(0.8) + col_w + gap, top_pos, col_w, card_h, "2. The Core Problem", ACCENT_AMBER)
    tb = s2.shapes.add_textbox(Inches(1.0) + col_w + gap, top_pos + Inches(0.6), col_w - Inches(0.4), card_h - Inches(0.8))
    tf = tb.text_frame
    tf.word_wrap = True
    prob_pts = [
        "Redis Pub/Sub is at-most-once: a brief network glitch drops messages silently with no recovery.",
        "No shared history: standard Pub/Sub provides no logs or global message ordering across multiple publishers.",
        "NLBs know nothing about rooms: client reconnects land randomly on different gateway nodes.",
        "Multi-tenant security risks: requires strict token authentication, rate limits, and cross-tenant isolation.",
    ]
    for pt in prob_pts:
        p = tf.add_paragraph() if tf.paragraphs[0].text else tf.paragraphs[0]
        p.text = f"• {pt}"
        p.font.size = Pt(11.5)
        p.font.color.rgb = TEXT_MAIN
        p.space_after = Pt(12)

    # 3. Objectives
    add_card(s2, Inches(0.8) + (col_w + gap)*2, top_pos, col_w, card_h, "3. Key Objectives", ACCENT_GREEN)
    tb = s2.shapes.add_textbox(Inches(1.0) + (col_w + gap)*2, top_pos + Inches(0.6), col_w - Inches(0.4), card_h - Inches(0.8))
    tf = tb.text_frame
    tf.word_wrap = True
    obj_pts = [
        "Atomic Sequencing: use a single Lua script as the linearization point with monotonic sequence numbers.",
        "Gap Repair & Resume: automatic XRANGE catch-up from Redis Streams + idempotent retry keys (cid).",
        "Fault Tolerance: gracefully handle gateway node crashes and Redis connection drops without message loss.",
        "Multi-Service Observability: live Discord UI, Backstage traffic simulator, and AWS CloudWatch/DynamoDB.",
    ]
    for pt in obj_pts:
        p = tf.add_paragraph() if tf.paragraphs[0].text else tf.paragraphs[0]
        p.text = f"• {pt}"
        p.font.size = Pt(11.5)
        p.font.color.rgb = TEXT_MAIN
        p.space_after = Pt(12)

    # ==========================================
    # SLIDE 3: SYSTEM ARCHITECTURE
    # ==========================================
    s3 = prs.slides.add_slide(blank_layout)
    set_slide_bg(s3)
    add_header(s3, "System Architecture: 4-Tier Topology")

    w_left = Inches(7.5)
    arch_tiers = [
        ("Tier 1: Clients Fleet", "Browser Discord UI, ResilientClient SDK with exponential backoff, and traffic load generator.", ACCENT_BLUE),
        ("Tier 2: L4 Load Balancer (NLB)", "AWS Network Load Balancer (TCP :80 -> :8080) or local Nginx. Uses flow-hash and /readyz health checks.", ACCENT_BLUE),
        ("Tier 3: Gateway Cluster (gw-1, gw-2, gw-3)", "Stateful WebSocket servers. Handles client sockets, gap repairs, presence, and rate limits. State is a disposable cache.", ACCENT_AMBER),
        ("Tier 4: Redis Backplane", "Pub/Sub (ultra-fast path) + Streams (durable log) + INCR Lua (sequencer) + ZSET (room presence).", ACCENT_GREEN),
    ]
    y_pos = Inches(1.4)
    for title, desc, col in arch_tiers:
        add_card(s3, Inches(0.8), y_pos, w_left, Inches(1.2), title, col)
        tb = s3.shapes.add_textbox(Inches(1.0), y_pos + Inches(0.45), w_left - Inches(0.4), Inches(0.65))
        tf = tb.text_frame
        tf.word_wrap = True
        p = tf.paragraphs[0]
        p.text = desc
        p.font.size = Pt(11)
        p.font.color.rgb = TEXT_MAIN
        y_pos += Inches(1.35)

    # Right Card: Observability & Cloud Hub
    w_right = Inches(3.9)
    add_card(s3, Inches(8.6), Inches(1.4), w_right, Inches(5.25), "Observability & Cloud Services", RGBColor(0xff, 0x99, 0x00))
    tb_aws = s3.shapes.add_textbox(Inches(8.8), Inches(2.0), w_right - Inches(0.4), Inches(4.5))
    tf_aws = tb_aws.text_frame
    tf_aws.word_wrap = True
    aws_lines = [
        ("AWS CloudWatch", "Live custom metrics (RequestsPerSec, ActiveConnections, DeliveryLatency, Throttling)."),
        ("Amazon DynamoDB", "Durable message audit store with tenant partition key and 7-day TTL expiration."),
        ("Amazon S3", "1-click room transcript backup and snapshot vault."),
        ("Amazon SNS", "Automated threat notification alerts on token-bucket DDoS spikes."),
        ("Deployment Modes", "Docker Compose (3 nodes + Redis + Nginx) or Terraform AWS NLB + EC2 + ElastiCache."),
    ]
    for b_title, b_desc in aws_lines:
        p = tf_aws.add_paragraph() if tf_aws.paragraphs[0].text else tf_aws.paragraphs[0]
        p.text = f"• {b_title}:\n  {b_desc}"
        p.font.size = Pt(10)
        p.font.color.rgb = TEXT_MAIN
        p.space_after = Pt(8)

    # ==========================================
    # SLIDE 4: PUBLISH, RECOVERY & RESUME FLOWS
    # ==========================================
    s4 = prs.slides.add_slide(blank_layout)
    set_slide_bg(s4)
    add_header(s4, "Publish, Recovery & Resume Flows")

    # 3 Flow Cards
    add_card(s4, Inches(0.8), top_pos, col_w, card_h, "PUBLISH FLOW", ACCENT_BLUE)
    tb = s4.shapes.add_textbox(Inches(1.0), top_pos + Inches(0.6), col_w - Inches(0.4), card_h - Inches(0.8))
    tf = tb.text_frame
    tf.word_wrap = True
    flow_1 = [
        "1. Client sends msg {room, text, cid}.",
        "2. Gateway validates rate-limit and auth token.",
        "3. Atomic Lua script runs in Redis:\n   • Checks cid deduplication\n   • Increments room seq\n   • Appends to Stream log (XADD)\n   • Broadcasts to Pub/Sub",
        "4. All gateways receive pub/sub event.",
        "5. Fan-out in strict seq order to all connected sockets.",
        "6. Sender receives ack {seq}.",
        "Key point: One atomic Lua script is the linearization point (pub/sub order = log order = seq order).",
    ]
    for line in flow_1:
        p = tf.add_paragraph() if tf.paragraphs[0].text else tf.paragraphs[0]
        p.text = line
        p.font.size = Pt(10.5)
        p.font.color.rgb = TEXT_MAIN if not line.startswith("Key") else ACCENT_AMBER
        p.space_after = Pt(8)

    add_card(s4, Inches(0.8) + col_w + gap, top_pos, col_w, card_h, "GAP REPAIR FLOW", ACCENT_AMBER)
    tb = s4.shapes.add_textbox(Inches(1.0) + col_w + gap, top_pos + Inches(0.6), col_w - Inches(0.4), card_h - Inches(0.8))
    tf = tb.text_frame
    tf.word_wrap = True
    flow_2 = [
        "1. Pub/sub misses a message due to a network blip.",
        "2. Gateway detects a sequence gap (e.g. gets #4 when local head is #2).",
        "3. Gateway queries Redis Stream: XRANGE for missing seq range (#3).",
        "4. Gateway delivers missing messages first in order.",
        "5. Then delivers the live message (#4).",
        "6. Duplicate messages (seq <= lastSeq) are safely dropped.",
        "Key point: Clients never see holes or duplicate messages even when pub/sub drops packets.",
    ]
    for line in flow_2:
        p = tf.add_paragraph() if tf.paragraphs[0].text else tf.paragraphs[0]
        p.text = line
        p.font.size = Pt(10.5)
        p.font.color.rgb = TEXT_MAIN if not line.startswith("Key") else ACCENT_AMBER
        p.space_after = Pt(8)

    add_card(s4, Inches(0.8) + (col_w + gap)*2, top_pos, col_w, card_h, "NODE RESUME FLOW", ACCENT_GREEN)
    tb = s4.shapes.add_textbox(Inches(1.0) + (col_w + gap)*2, top_pos + Inches(0.6), col_w - Inches(0.4), card_h - Inches(0.8))
    tf = tb.text_frame
    tf.word_wrap = True
    flow_3 = [
        "1. A gateway node crashes or restarts.",
        "2. Client detects disconnect and backs off (jittered exponential reconnect).",
        "3. NLB picks another healthy survivor node (e.g. gw-2).",
        "4. Client sends resume frame: join {room, lastSeq: 42}.",
        "5. Survivor node replays missed messages from Stream log starting at 42.",
        "6. Client transitions to live stream seamlessly.",
        "Key point: Gateway nodes are disposable because clients carry lastSeq and Redis carries the log.",
    ]
    for line in flow_3:
        p = tf.add_paragraph() if tf.paragraphs[0].text else tf.paragraphs[0]
        p.text = line
        p.font.size = Pt(10.5)
        p.font.color.rgb = TEXT_MAIN if not line.startswith("Key") else ACCENT_AMBER
        p.space_after = Pt(8)

    # ==========================================
    # SLIDE 5: CORE COMPONENTS & REDIS DATA MODEL
    # ==========================================
    s5 = prs.slides.add_slide(blank_layout)
    set_slide_bg(s5)
    add_header(s5, "Core Components & Redis Data Model")

    # Table on Left: Redis Structures
    table_shape = s5.shapes.add_table(6, 2, Inches(0.8), Inches(1.4), Inches(6.0), Inches(5.3))
    table = table_shape.table
    table.columns[0].width = Inches(2.2)
    table.columns[1].width = Inches(3.8)

    headers = ["Redis Structure", "Purpose & Guarantee"]
    for col_idx, h in enumerate(headers):
        cell = table.cell(0, col_idx)
        cell.fill.solid()
        cell.fill.fore_color.rgb = RGBColor(0x28, 0x2b, 0x48)
        p = cell.text_frame.paragraphs[0]
        p.text = h
        p.font.size = Pt(12)
        p.font.bold = True
        p.font.color.rgb = RGBColor(0x8c, 0x97, 0xff)

    redis_rows = [
        ("Sequencer (INCR)", "Per-room monotonic sequence counter; establishes global total order."),
        ("Stream Log (XADD)", "Durable append-only history; source for gap repairs and resumes."),
        ("Pub/Sub Channel", "Ultra-low-latency broadcast conduit across gateway nodes."),
        ("Dedupe Key (cid)", "Idempotent retry window (TTL: 5 min); drops duplicated sends."),
        ("Presence (ZSET)", "Active room member roster with timestamp score & 30s TTL expiry."),
    ]
    for row_idx, (k, v) in enumerate(redis_rows, start=1):
        cell_k = table.cell(row_idx, 0)
        cell_k.fill.solid()
        cell_k.fill.fore_color.rgb = CARD_BG
        p = cell_k.text_frame.paragraphs[0]
        p.text = k
        p.font.size = Pt(11)
        p.font.bold = True
        p.font.color.rgb = TEXT_MAIN

        cell_v = table.cell(row_idx, 1)
        cell_v.fill.solid()
        cell_v.fill.fore_color.rgb = CARD_BG
        p2 = cell_v.text_frame.paragraphs[0]
        p2.text = v
        p2.font.size = Pt(10.5)
        p2.font.color.rgb = TEXT_MUTED

    # Right Card: Core System Components
    w_comp = Inches(5.4)
    add_card(s5, Inches(7.1), Inches(1.4), w_comp, Inches(5.3), "Core System Components", ACCENT_GREEN)
    tb_c = s5.shapes.add_textbox(Inches(7.3), Inches(1.95), w_comp - Inches(0.4), Inches(4.6))
    tf_c = tb_c.text_frame
    tf_c.word_wrap = True
    comp_items = [
        ("Gateway Node", "HTTP + WebSocket server, socket tracking, in-memory queue, and graceful drain (503 on /readyz)."),
        ("Redis Backplane", "Atomic Lua scripts, Stream logs, presence sets, auto-reconnect, and half-open socket watchdog."),
        ("Memory Backplane", "In-process fallback test double supporting simulated outages and loss injection."),
        ("ResilientClient SDK", "Client-side ordering, deduplication, automatic resume from lastSeq, and idempotent retries."),
        ("Hash-Tag Routing", "Keys carry a {tenant:room} hash tag so each room stays in one Redis slot for atomic multi-key scripts."),
    ]
    for title, desc in comp_items:
        p = tf_c.add_paragraph() if tf_c.paragraphs[0].text else tf_c.paragraphs[0]
        p.text = f"• {title}: {desc}"
        p.font.size = Pt(11)
        p.font.color.rgb = TEXT_MAIN
        p.space_after = Pt(10)

    # ==========================================
    # SLIDE 6: MULTI-TENANT SECURITY MODEL
    # ==========================================
    s6 = prs.slides.add_slide(blank_layout)
    set_slide_bg(s6)
    add_header(s6, "Multi-Tenant Security Model")

    table_shape = s6.shapes.add_table(7, 3, Inches(0.8), Inches(1.4), Inches(11.733), Inches(5.3))
    table = table_shape.table
    table.columns[0].width = Inches(2.6)
    table.columns[1].width = Inches(5.2)
    table.columns[2].width = Inches(3.9)

    sec_headers = ["Security Threat", "Architectural Control / Defense", "Implementation Detail"]
    for col_idx, h in enumerate(sec_headers):
        cell = table.cell(0, col_idx)
        cell.fill.solid()
        cell.fill.fore_color.rgb = RGBColor(0x28, 0x2b, 0x48)
        p = cell.text_frame.paragraphs[0]
        p.text = h
        p.font.size = Pt(12)
        p.font.bold = True
        p.font.color.rgb = RGBColor(0x8c, 0x97, 0xff)

    sec_rows = [
        ("Unauthenticated Access", "JWT verified during HTTP WebSocket upgrade before socket exists.", "Rejects missing / forged / expired tokens (HTTP 401)."),
        ("Cross-Tenant Crosstalk", "Tenant identifier extracted strictly from token; all keys namespaced.", "{tenant:room} isolation prevents cross-organization leaks."),
        ("Injection via Names", "Strict identifier validation matching ^[A-Za-z0-9_-]{1,32}$.", "Prevents path traversal, delimiter injection, and malformed frames."),
        ("Flooding & DDoS", "Per-connection token bucket rate limiter (20 msg/s, burst 40).", "Returns error 'rate_limited'; dispatches Amazon SNS threat alerts."),
        ("Slow Consumer Attack", "Socket buffer capped at 1 MB per client.", "Severed immediately (code 1013) to protect gateway node heap."),
        ("Replay Attacks", "Idempotency key (cid) cached in Redis for 5 minutes.", "Retried messages receive identical sequence number without duplication."),
    ]
    for row_idx, (t, c, d) in enumerate(sec_rows, start=1):
        cell_t = table.cell(row_idx, 0)
        cell_t.fill.solid()
        cell_t.fill.fore_color.rgb = CARD_BG
        p = cell_t.text_frame.paragraphs[0]
        p.text = t
        p.font.size = Pt(11)
        p.font.bold = True
        p.font.color.rgb = TEXT_MAIN

        cell_c = table.cell(row_idx, 1)
        cell_c.fill.solid()
        cell_c.fill.fore_color.rgb = CARD_BG
        p2 = cell_c.text_frame.paragraphs[0]
        p2.text = c
        p2.font.size = Pt(10.5)
        p2.font.color.rgb = TEXT_MAIN

        cell_d = table.cell(row_idx, 2)
        cell_d.fill.solid()
        cell_d.fill.fore_color.rgb = CARD_BG
        p3 = cell_d.text_frame.paragraphs[0]
        p3.text = d
        p3.font.size = Pt(10)
        p3.font.color.rgb = TEXT_MUTED

    # ==========================================
    # SLIDE 7: BACKSTAGE DASHBOARD & SIMULATOR
    # ==========================================
    s7 = prs.slides.add_slide(blank_layout)
    set_slide_bg(s7)
    add_header(s7, "Backstage Dashboard & Traffic Simulator")

    # 3 Cards
    add_card(s7, Inches(0.8), top_pos, col_w, card_h, "1. Live Dashboard", ACCENT_BLUE)
    tb = s7.shapes.add_textbox(Inches(1.0), top_pos + Inches(0.6), col_w - Inches(0.4), card_h - Inches(0.8))
    tf = tb.text_frame
    tf.word_wrap = True
    d_pts = [
        "Dynamic SVG request-flow diagram displaying packet transit in real-time.",
        "Interactive: click any node (API Gateway, NLB, gw nodes, Redis, AWS) to inspect live state and guarantees.",
        "Multi-service health grid for Redis, NLB, gateway workers, and cloud services.",
        "View modes: Discord Chat (full width), Backstage Observability (full width), or Split Screen.",
        "Multi-user testing: built-in 'Switch User' button and URL parameters (?user=Alice).",
    ]
    for pt in d_pts:
        p = tf.add_paragraph() if tf.paragraphs[0].text else tf.paragraphs[0]
        p.text = f"• {pt}"
        p.font.size = Pt(11)
        p.font.color.rgb = TEXT_MAIN
        p.space_after = Pt(10)

    add_card(s7, Inches(0.8) + col_w + gap, top_pos, col_w, card_h, "2. Traffic Simulator", ACCENT_AMBER)
    tb = s7.shapes.add_textbox(Inches(1.0) + col_w + gap, top_pos + Inches(0.6), col_w - Inches(0.4), card_h - Inches(0.8))
    tf = tb.text_frame
    tf.word_wrap = True
    s_pts = [
        "Virtual Clients: scale concurrent bots from 1 to 100 with interactive sliders.",
        "Request Rate: adjustable from 1 to 50 req/sec on the fly.",
        "Traffic Profiles: Steady Load, Traffic Surge Burst, DDoS Throttling (HTTP 429), and Chaos Failover.",
        "Live Meters: instant counters for Total Requests, Delivered, Throttled, and Hop Latencies.",
        "Drop & Catchup: 1-click button to simulate connection drop and watch gap repair live.",
    ]
    for pt in s_pts:
        p = tf.add_paragraph() if tf.paragraphs[0].text else tf.paragraphs[0]
        p.text = f"• {pt}"
        p.font.size = Pt(11)
        p.font.color.rgb = TEXT_MAIN
        p.space_after = Pt(10)

    add_card(s7, Inches(0.8) + (col_w + gap)*2, top_pos, col_w, card_h, "3. CloudWatch Integration", ACCENT_GREEN)
    tb = s7.shapes.add_textbox(Inches(1.0) + (col_w + gap)*2, top_pos + Inches(0.6), col_w - Inches(0.4), card_h - Inches(0.8))
    tf = tb.text_frame
    tf.word_wrap = True
    c_pts = [
        "AWS Learner Lab: enters credentials via UI modal ($50 credits).",
        "Namespace: SSDMicroProject/ChatCluster streams telemetry every 5s.",
        "CloudWatch Metrics: RequestsPerSec, ActiveConnections, DeliveryLatency, RateLimited.",
        "Automatic Header Sanitization: cleans session token newlines and formatting seamlessly.",
        "Local Fallback Mode: runs gracefully offline or without AWS credentials.",
    ]
    for pt in c_pts:
        p = tf.add_paragraph() if tf.paragraphs[0].text else tf.paragraphs[0]
        p.text = f"• {pt}"
        p.font.size = Pt(11)
        p.font.color.rgb = TEXT_MAIN
        p.space_after = Pt(10)

    # ==========================================
    # SLIDE 8: VERIFICATION RESULTS & TECH STACK
    # ==========================================
    s8 = prs.slides.add_slide(blank_layout)
    set_slide_bg(s8)
    add_header(s8, "Verification Results & Technology Stack")

    # Table on Left
    table_shape = s8.shapes.add_table(8, 2, Inches(0.8), Inches(1.4), Inches(6.8), Inches(5.3))
    table = table_shape.table
    table.columns[0].width = Inches(4.8)
    table.columns[1].width = Inches(2.0)

    t_headers = ["Test Scenario", "Result"]
    for col_idx, h in enumerate(t_headers):
        cell = table.cell(0, col_idx)
        cell.fill.solid()
        cell.fill.fore_color.rgb = RGBColor(0x28, 0x2b, 0x48)
        p = cell.text_frame.paragraphs[0]
        p.text = h
        p.font.size = Pt(12)
        p.font.bold = True
        p.font.color.rgb = RGBColor(0x8c, 0x97, 0xff)

    test_rows = [
        ("Unit & Observability (TokenBucket, Security, Ordering)", "15 / 15 Pass"),
        ("Integration: 3 Gateways + Redis + NLB", "5 / 5 Pass"),
        ("F1: Redis Link Reset (2s TCP sever mid-stream)", "Pass (No loss, in order)"),
        ("F2: Redis Half-Open Link (Watchdog heartbeat kill)", "Pass (Reset triggered)"),
        ("F3: Redis Injected Latency (+120ms)", "Pass (Gaps repaired)"),
        ("F4: Gateway SIGKILL under 100 req/s load", "Pass (Clients resumed)"),
        ("F5: Rolling Zero-Downtime Restart of all 3 Nodes", "Pass (12 reconnects, 0 loss)"),
    ]
    for row_idx, (t, r) in enumerate(test_rows, start=1):
        cell_t = table.cell(row_idx, 0)
        cell_t.fill.solid()
        cell_t.fill.fore_color.rgb = CARD_BG
        p = cell_t.text_frame.paragraphs[0]
        p.text = t
        p.font.size = Pt(10.5)
        p.font.color.rgb = TEXT_MAIN

        cell_r = table.cell(row_idx, 1)
        cell_r.fill.solid()
        cell_r.fill.fore_color.rgb = CARD_BG
        p2 = cell_r.text_frame.paragraphs[0]
        p2.text = r
        p2.font.size = Pt(10.5)
        p2.font.bold = True
        p2.font.color.rgb = ACCENT_GREEN

    # Right Card: Tech Stack
    w_stack = Inches(4.6)
    add_card(s8, Inches(7.9), Inches(1.4), w_stack, Inches(5.3), "Technology Stack", ACCENT_BLUE)
    tb_st = s8.shapes.add_textbox(Inches(8.1), Inches(1.95), w_stack - Inches(0.4), Inches(4.6))
    tf_st = tb_st.text_frame
    tf_st.word_wrap = True
    stack_lines = [
        ("Runtime & Language", "Node.js 22 LTS + TypeScript 5.5 (tsx execution)."),
        ("WebSockets", "ws 8.18 (RFC 6455 JSON text frames)."),
        ("Redis Driver", "ioredis 5.4 (Lua evaluation & connection watchdog)."),
        ("Security", "jsonwebtoken 9.0 (HMAC-SHA256 token verification)."),
        ("AWS SDKs", "@aws-sdk/client-cloudwatch, dynamodb, s3, sns."),
        ("Containers & Proxy", "Docker Compose v2 & Nginx 1.27."),
        ("Infrastructure as Code", "Terraform on AWS (NLB + EC2 + ElastiCache)."),
        ("Test Harness", "node:test built-in test runner."),
    ]
    for k, v in stack_lines:
        p = tf_st.add_paragraph() if tf_st.paragraphs[0].text else tf_st.paragraphs[0]
        p.text = f"• {k}: {v}"
        p.font.size = Pt(10.5)
        p.font.color.rgb = TEXT_MAIN
        p.space_after = Pt(7)

    # ==========================================
    # SLIDE 9: BENCHMARKS (LOCAL, 1 vCPU)
    # ==========================================
    s9 = prs.slides.add_slide(blank_layout)
    set_slide_bg(s9)
    add_header(s9, "Benchmarks (Local, 1 vCPU)")

    w_bench = Inches(4.5)
    add_card(s9, Inches(0.8), Inches(1.4), w_bench, Inches(5.3), "Capacity & Latency Baselines", ACCENT_BLUE)
    tb_b = s9.shapes.add_textbox(Inches(1.0), Inches(1.95), w_bench - Inches(0.4), Inches(4.6))
    tf_b = tb_b.text_frame
    tf_b.word_wrap = True
    bench_items = [
        ("0 Send Errors", "Zero send errors; 0 divergent rooms across all concurrency stress tests."),
        ("4,787 Deliveries/s", "Sustained throughput achieved across 1,000 concurrent connections (Scenario S3)."),
        ("488 ms Reconnect Stall", "Longest stall recorded when 1 of 3 gateway nodes was killed abruptly under load (Scenario S4)."),
        ("Single-Core Sandbox", "Generator, 3 gateways, and Redis share a single CPU core. A correctness baseline proving architectural invariants hold even under resource starvation."),
    ]
    for b_title, b_desc in bench_items:
        p = tf_b.add_paragraph() if tf_b.paragraphs[0].text else tf_b.paragraphs[0]
        p.text = f"• {b_title}:\n  {b_desc}"
        p.font.size = Pt(11)
        p.font.color.rgb = TEXT_MAIN
        p.space_after = Pt(12)

    # Right Chart Picture
    chart_path = "C:/Users/TANVI/.gemini/antigravity/brain/a0bdccca-770c-4fc0-b4bf-d3da8b20eb61/.user_uploaded/media_1793803816584_8c0fa034.png"
    if os.path.exists(chart_path):
        add_card(s9, Inches(5.6), Inches(1.4), Inches(6.9), Inches(5.3), "End-to-End Latency (ms): p50 · p95 · p99", ACCENT_GREEN)
        s9.shapes.add_picture(chart_path, Inches(5.8), Inches(2.0), width=Inches(6.5))

    # ==========================================
    # SLIDE 10: DEPLOYMENT, RISKS & LIMITS
    # ==========================================
    s10 = prs.slides.add_slide(blank_layout)
    set_slide_bg(s10)
    add_header(s10, "Deployment Tiers, Risks & Mitigations")

    # Left: Deployment Tiers
    w_d = Inches(5.6)
    add_card(s10, Inches(0.8), Inches(1.4), w_d, Inches(5.3), "Deployment Tiers", ACCENT_BLUE)
    tb_dt = s10.shapes.add_textbox(Inches(1.0), Inches(1.95), w_d - Inches(0.4), Inches(4.6))
    tf_dt = tb_dt.text_frame
    tf_dt.word_wrap = True
    tiers_info = [
        ("Tier 0 ($0)", "docker compose up (Nginx, 3 gateways, Redis) or single-node memory mode. Used for all local development, tests, and rehearsals."),
        ("Tier 1 ($0)", "Local gateways paired with managed free Redis (Upstash / Redis Cloud). Connects over TLS (rediss://)."),
        ("Tier 2 (AWS Credits)", "AWS Network Load Balancer + 2x EC2 instances + ElastiCache cache.t4g.micro. Covered by $50 Learner Lab credits; tear down with terraform destroy after testing."),
    ]
    for k, v in tiers_info:
        p = tf_dt.add_paragraph() if tf_dt.paragraphs[0].text else tf_dt.paragraphs[0]
        p.text = f"• {k}:\n  {v}"
        p.font.size = Pt(11)
        p.font.color.rgb = TEXT_MAIN
        p.space_after = Pt(14)

    # Right: Risks & Mitigations Table
    table_shape = s10.shapes.add_table(6, 2, Inches(6.7), Inches(1.4), Inches(5.8), Inches(5.3))
    table = table_shape.table
    table.columns[0].width = Inches(2.5)
    table.columns[1].width = Inches(3.3)

    r_headers = ["Identified Risk", "Architectural Mitigation"]
    for col_idx, h in enumerate(r_headers):
        cell = table.cell(0, col_idx)
        cell.fill.solid()
        cell.fill.fore_color.rgb = RGBColor(0x28, 0x2b, 0x48)
        p = cell.text_frame.paragraphs[0]
        p.text = h
        p.font.size = Pt(11.5)
        p.font.bold = True
        p.font.color.rgb = RGBColor(0x8c, 0x97, 0xff)

    risk_rows = [
        ("Redis Outage", "Reject writes (CP mode), client retries with cid, catch-up upon recovery."),
        ("Gateway Node Crash", "Disposable workers; clients resume from lastSeq on surviving node."),
        ("Lost Pub/Sub Message", "Self-healing: XRANGE gap fill from durable Redis Stream log."),
        ("Seq Rewind on Data Loss", "Epoch identifier reset; ElastiCache Multi-AZ with AOF persistence."),
        ("Cloud Provider Costs", "Set AWS Budget alerts at $10 & $25; run terraform destroy after demo."),
    ]
    for row_idx, (r, m) in enumerate(risk_rows, start=1):
        cell_r = table.cell(row_idx, 0)
        cell_r.fill.solid()
        cell_r.fill.fore_color.rgb = CARD_BG
        p = cell_r.text_frame.paragraphs[0]
        p.text = r
        p.font.size = Pt(10.5)
        p.font.bold = True
        p.font.color.rgb = TEXT_MAIN

        cell_m = table.cell(row_idx, 1)
        cell_m.fill.solid()
        cell_m.fill.fore_color.rgb = CARD_BG
        p2 = cell_m.text_frame.paragraphs[0]
        p2.text = m
        p2.font.size = Pt(10.5)
        p2.font.color.rgb = TEXT_MUTED

    # ==========================================
    # SLIDE 11: CONCLUSION & REFERENCES
    # ==========================================
    s11 = prs.slides.add_slide(blank_layout)
    set_slide_bg(s11)
    add_header(s11, "Conclusion & Academic References")

    w_half = Inches(5.6)
    # Left: Conclusion
    add_card(s11, Inches(0.8), Inches(1.4), w_half, Inches(5.3), "Conclusion & Achievements", ACCENT_GREEN)
    tb_c = s11.shapes.add_textbox(Inches(1.0), Inches(1.95), w_half - Inches(0.4), Inches(4.6))
    tf_c = tb_c.text_frame
    tf_c.word_wrap = True
    concl_pts = [
        ("Raw NLB + Redis Pub/Sub Transformed", "Turned into a production-grade gateway with total order, durability, and failure tolerance."),
        ("Atomic Lua Linearization", "Atomic Lua publish plus Stream replay guarantees zero loss and zero duplicates."),
        ("Comprehensive Verification", "20+ tests green across unit, integration, and six brutal fault-injection scenarios."),
        ("Next Steps / Future Work", "Run Tier 2 AWS benchmarks, implement session epoch IDs, and compare against a naive pub/sub baseline."),
    ]
    for title, desc in concl_pts:
        p = tf_c.add_paragraph() if tf_c.paragraphs[0].text else tf_c.paragraphs[0]
        p.text = f"• {title}:\n  {desc}"
        p.font.size = Pt(11)
        p.font.color.rgb = TEXT_MAIN
        p.space_after = Pt(12)

    # Right: References
    add_card(s11, Inches(6.9), Inches(1.4), w_half, Inches(5.3), "References & Technical Standards", ACCENT_BLUE)
    tb_r = s11.shapes.add_textbox(Inches(7.1), Inches(1.95), w_half - Inches(0.4), Inches(4.6))
    tf_r = tb_r.text_frame
    tf_r.word_wrap = True
    ref_list = [
        ("Linearizability Theory", "Herlihy & Wing, Linearizability: A Correctness Condition for Concurrent Objects, ACM TOPLAS 12(3), 1990."),
        ("Distributed Systems", "Kleppmann, Designing Data-Intensive Applications, O'Reilly Media, 2017."),
        ("WebSocket Protocol", "Fette & Melnikov, RFC 6455: The WebSocket Protocol, IETF, 2011."),
        ("Redis Architecture", "Redis Documentation: Pub/Sub, Streams, and Lua scripting models."),
        ("AWS Infrastructure", "Amazon Web Services Documentation: Network Load Balancer TCP flow-hash specifications."),
    ]
    for title, desc in ref_list:
        p = tf_r.add_paragraph() if tf_r.paragraphs[0].text else tf_r.paragraphs[0]
        p.text = f"• {title}:\n  {desc}"
        p.font.size = Pt(10.5)
        p.font.color.rgb = TEXT_MAIN
        p.space_after = Pt(10)

    prs.save(output_path)
    print(f"Presentation saved successfully to: {output_path}")

if __name__ == "__main__":
    out_file = os.path.join(os.getcwd(), "docs", "SSD_Micro_Project_Presentation_V2.pptx")
    create_deck(out_file)
