def normalize_name(name):
    return " ".join(name.split()).title()


def slugify(name):
    return normalize_name(name).lower().replace(" ", "-")
