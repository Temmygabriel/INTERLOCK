# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *


class Hello(gl.Contract):
    greeting: str

    def __init__(self, who: str):
        self.greeting = "hello " + who

    @gl.public.view
    def greet(self) -> str:
        return self.greeting
