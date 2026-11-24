import config as cfg
from text_utils import normalize_name


def main(argv):
    settings = cfg.load_config(argv[1])
    name = normalize_name(argv[2])
    return settings, name
