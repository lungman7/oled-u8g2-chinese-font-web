"""Gunicorn 正式環境設定；只監聽本機，由 Nginx 對外提供服務。"""

bind = "127.0.0.1:8082"
workers = 2
threads = 2
timeout = 45
accesslog = "-"
errorlog = "-"
