import socket
from contextlib import closing

from src import desktop, main
from src.common.network import find_available_port


def test_startup_parsers_accept_preferred_port():
    assert main._parse_args(["--port", "9000"]).port == 9000
    assert desktop._parse_args(["--port", "9001"]).port == 9001


def test_find_available_port_falls_back_when_preferred_is_occupied():
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        occupied_port = int(listener.getsockname()[1])

        selected_port = find_available_port(occupied_port)

    assert selected_port != occupied_port
    assert 1 <= selected_port <= 65535
