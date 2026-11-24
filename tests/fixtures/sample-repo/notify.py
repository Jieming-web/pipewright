from audit import audit_event


def send_notice(user, message):
    audit_event("notice", user)
    return "to %s: %s" % (user, message)
