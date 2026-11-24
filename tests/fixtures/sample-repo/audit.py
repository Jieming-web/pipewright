EVENTS = []


def audit_event(kind, who):
    EVENTS.append((kind, who))
    return len(EVENTS)
