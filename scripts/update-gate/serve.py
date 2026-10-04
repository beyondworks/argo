# Local HTTPS mirror for the update-path gate (CI only): serves <root> on :443 for both IPv4 and IPv6 and logs every request.
# usage: sudo python3 serve.py <root> <cert> <key> <log> [port, default 443]
import datetime
import functools
import http.server
import socket
import ssl
import sys

root, cert, key, log = sys.argv[1:5]
port = int(sys.argv[5]) if len(sys.argv) > 5 else 443


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        with open(log, 'a') as f:
            headers = getattr(self, 'headers', None)  # 요청 줄을 못 읽은 오류 기록에는 헤더가 없다
            f.write('%s %s %s\n' % (datetime.datetime.now().isoformat(timespec='seconds'), headers.get('User-Agent', '-') if headers else '-', fmt % args))


class DualStack(http.server.ThreadingHTTPServer):
    address_family = socket.AF_INET6

    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(cert, key)
httpd = DualStack(('::', port), functools.partial(Handler, directory=root))
httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
httpd.serve_forever()
