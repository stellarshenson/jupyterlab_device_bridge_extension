import json


async def test_hello(jp_fetch):
    # When
    response = await jp_fetch("jupyterlab-device-bridge-extension", "hello")

    # Then
    assert response.code == 200
    payload = json.loads(response.body)
    assert payload == {
            "data": (
                "Hello, world!"
                " This is the '/jupyterlab-device-bridge-extension/hello' endpoint."
                " Try visiting me in your browser!"
            ),
        }
