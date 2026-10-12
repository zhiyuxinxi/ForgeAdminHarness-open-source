import importlib.util
import pathlib
import unittest


SCRIPT = pathlib.Path(__file__).parents[1] / "scripts" / "file_gateway_admin.py"
SPEC = importlib.util.spec_from_file_location("file_gateway_admin", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class FileGatewayAdminTests(unittest.TestCase):
    def test_permissions_keep_root_read_only_and_projects_upload_only(self):
        permissions = MODULE.build_permissions(["project-b", "project-a", "project-a"])
        self.assertEqual(permissions["/"], ["list"])
        self.assertEqual(
            list(permissions), ["/", "/project-a", "/project-b"]
        )
        self.assertEqual(
            permissions["/project-a"], ["list", "upload", "create_dirs"]
        )
        self.assertNotIn("download", permissions["/project-a"])
        self.assertNotIn("delete", permissions["/project-a"])
        self.assertNotIn("overwrite", permissions["/project-a"])

    def test_invalid_project_slug_is_rejected(self):
        with self.assertRaises(ValueError):
            MODULE.build_permissions(["../other-project"])

    def test_user_inherits_primary_upload_group(self):
        payload = MODULE.build_user_payload(
            "product-user", "a" * 32, "forge-all-projects-upload", "Product"
        )
        self.assertEqual(
            payload["groups"], [{"name": "forge-all-projects-upload", "type": 1}]
        )
        self.assertEqual(payload["permissions"], {"/": ["list"]})

    def test_short_password_is_rejected(self):
        with self.assertRaises(ValueError):
            MODULE.build_user_payload("product-user", "short", "group", "Product")

    def test_password_update_preserves_account_and_drops_read_only_fields(self):
        payload = MODULE.build_password_update_payload(
            {
                "username": "product-user",
                "status": 1,
                "permissions": {"/": ["list"]},
                "has_password": True,
                "created_at": 123,
                "updated_at": 456,
            },
            "fixture-password-9x",
        )
        self.assertEqual(payload["password"], "fixture-password-9x")
        self.assertEqual(payload["permissions"], {"/": ["list"]})
        self.assertNotIn("has_password", payload)
        self.assertNotIn("created_at", payload)
        self.assertNotIn("updated_at", payload)

    def test_replacement_password_requires_eight_characters(self):
        with self.assertRaises(ValueError):
            MODULE.build_password_update_payload({"username": "product-user"}, "short")


if __name__ == "__main__":
    unittest.main()
