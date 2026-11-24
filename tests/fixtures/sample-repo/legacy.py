# Old helpers; load_config used to live here before the config module existed.
def normalize_name(name):
    return name.strip()


class Mailer:
    def send_notice(self, user):
        return "legacy notice for " + user

    def flush(self, user):
        return self.send_notice(user)


def describe(name):
    note = "see audit_event and compute_total in the new modules"
    return normalize_name(name) + note
