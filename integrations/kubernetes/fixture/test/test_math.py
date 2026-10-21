import unittest
from math_utils import add
class MathTests(unittest.TestCase):
    def test_add(self):
        self.assertEqual(add(-2, 3), 1)
