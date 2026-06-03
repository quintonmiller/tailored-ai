#!/usr/bin/env python3
"""Hello TAI — a simple greeting script for TAI Personal.

Usage examples:

    # Default greeting
    $ python scripts/hello_tai.py
    Hello from TAI Personal!

    # Greet a specific person
    $ python scripts/hello_tai.py --name Alice
    Hello from TAI Personal! Hello, Alice!
"""

import argparse


def main():
    parser = argparse.ArgumentParser(description="Print a greeting for TAI Personal.")
    parser.add_argument("--name", type=str, default=None, help="Name to include in the greeting.")
    args = parser.parse_args()

    if args.name:
        print(f"Hello from TAI Personal! Hello, {args.name}!")
    else:
        print("Hello from TAI Personal!")


if __name__ == "__main__":
    main()
