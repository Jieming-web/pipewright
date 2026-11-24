from text_utils import normalize_name


def compute_total(items, tax=0.0):
    return sum(items) * (1 + tax)


def invoice_label(customer):
    return "Invoice for " + normalize_name(customer)


def invoice_total(items):
    return compute_total(items, 0.2)
