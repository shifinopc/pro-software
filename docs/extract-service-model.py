"""Turn the raw app dump into the structure the client document needs.

Everything here is READ from the running system -- node labels, roles, SLAs, checklists, captures and
document types. Nothing is described that the application does not actually do, which is the whole
point of handing this to a client.
"""
import io, json, collections

D = json.load(io.open("app-dump.json", encoding="utf-8"))
checklists = {c["name"]: c for c in D["checklists"]}
by_id = {}
for c in D["checklists"]:
    by_id[c.get("id")] = c

TYPE_LABEL = {
    "start": "Start", "task": "Task", "approval": "Approval", "decision": "Decision",
    "issue_document": "Issue / renew document", "notify": "Notification", "delay": "Wait",
    "parallel_split": "Parallel split", "parallel_join": "Parallel join", "end": "End",
    "invoice": "Draft invoice", "charge_fee": "Draft invoice", "courier": "Courier",
}
ROLE_LABEL = {
    "pro_officer": "PRO Officer", "accountant": "Accountant", "hr_officer": "HR Officer",
    "it_officer": "IT Officer", "admin": "Manager", "super_admin": "Administrator", "sales": "Sales",
}


def role(r):
    r = (r or "").strip()
    return ROLE_LABEL.get(r, r.replace("_", " ").title() if r else "")


def hours(h):
    if not h:
        return ""
    h = int(h)
    if h % 24 == 0 and h >= 24:
        d = h // 24
        return f"{d} working day{'' if d == 1 else 's'}"
    return f"{h} hours"


def checklist_for(cfg, rule_index):
    """The documents a step collects: a named rule, or the step's own list."""
    if cfg.get("checklistSource") == "dynamic" and cfg.get("checklistRuleId"):
        rid = cfg["checklistRuleId"]
        rule = rule_index.get(rid)
        if rule:
            items = []
            for row in (rule.get("rows") or []):
                for d in (row.get("documents") or []):
                    lab = d.get("label") or d.get("key")
                    if lab and lab not in items:
                        items.append(lab + ("" if d.get("required", True) else "  (optional)"))
            return rule["name"], items
        return "(a checklist rule)", []
    own = cfg.get("checklist") or []
    items = [(d.get("label") or d.get("key")) for d in own if (d.get("label") or d.get("key"))]
    return ("", items) if items else ("", [])


def captures_for(cfg):
    out = []
    for c in (cfg.get("captures") or []):
        lab = c.get("label") or c.get("var")
        if not lab:
            continue
        t = str(c.get("type") or "text")
        opts = str(c.get("options") or "")
        detail = t
        if opts:
            detail = "choice: " + ", ".join(x.strip() for x in opts.split(",") if x.strip())
        if c.get("required") is False:
            detail += " (optional)"
        out.append((lab, detail))
    return out


def build(tpl, rule_index):
    g = tpl.get("graph") or {}
    nodes = g.get("nodes") or []
    edges = g.get("edges") or []
    outgoing = collections.defaultdict(list)
    for e in edges:
        outgoing[e.get("from")].append(e)

    steps = []
    for n in nodes:
        cfg = n.get("config") or {}
        rule_name, items = checklist_for(cfg, rule_index)
        branches = []
        if n.get("type") == "decision":
            for e in outgoing.get(n.get("id"), []):
                tgt = next((x for x in nodes if x.get("id") == e.get("to")), None)
                cond = e.get("condition") or "otherwise"
                branches.append((cond, (tgt or {}).get("label") or e.get("to")))
        steps.append({
            "id": n.get("id"),
            "label": n.get("label") or n.get("id"),
            "type": TYPE_LABEL.get(n.get("type"), (n.get("type") or "").replace("_", " ").title()),
            "raw_type": n.get("type"),
            "role": role(cfg.get("assigneeRole") or cfg.get("approverRole")),
            "authority": cfg.get("govCenter") or "",
            "sla": hours(cfg.get("slaHours")),
            "instructions": (cfg.get("instructions") or "").strip(),
            "checklist_rule": rule_name,
            "checklist": items,
            "captures": captures_for(cfg),
            "doc_type": cfg.get("docType") or "",
            "branches": branches,
            "creates_employee": bool(cfg.get("createsEmployee")),
        })
    return steps


rule_index = {c["id"]: c for c in D["checklists"]}

out = {"templates": [], "docTypes": D["docTypes"], "authorities": D["authorities"],
       "checklists": D["checklists"], "services": D["services"]}
for t in D["templates"]:
    out["templates"].append({
        "name": t["name"], "country": t["country"], "trigger": t["trigger"],
        "triggerConfig": t.get("triggerConfig") or {}, "entityType": t.get("entityType"),
        "active": t.get("active"), "steps": build(t, rule_index),
    })

io.open("app-model.json", "w", encoding="utf-8").write(json.dumps(out, indent=1, ensure_ascii=False))
print("templates:", [(t["name"], len(t["steps"])) for t in out["templates"]])
