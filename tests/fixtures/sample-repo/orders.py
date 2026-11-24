import audit
from billing import compute_total as total_of
from notify import send_notice


def place_order(user, items):
    total = total_of(items)
    send_notice(user, "total %s" % total)
    audit.audit_event("order", user)
    return total
