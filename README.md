# CS2 Nest.js Inspect server

This is a simple inspect server for the CS2 Nestjs application. It is used to inspect the data that is being sent to the server. 

## Installation

It is recommended to use pnpm to install the dependencies. If you don't have pnpm installed, you can install it using the following command: 

```bash
$ npm install -g pnpm
```

Then, you can install the dependencies using the following command:

```bash
$ pnpm install
```

## Deployment

You can deploy the server using the following command:

```bash
$ pnpm run build
```

The server will be built in the `dist` directory. You can run the server using the following command:

```bash
$ node dist/main.js
```

You can also use the following command to run the server:

```bash
$ pnpm run deploy
```

This will build and run the server in one command with PM2.

## Docker

You can also run the server using Docker. You can build the Docker image using the following command:

```bash
$ docker build -t cs2-inspect-server .
```

Then, you can run the Docker container using the following command:

```bash
$ docker run -p 3000:3000 -d cs2-inspect-server
```


## Configuration

The server is configured to run on port 3000. If you want to change the port, you can do so by modifying the `PORT` environment variable in the `.env` file. 
    
```bash
PORT=3000
```

### Database

The server uses a PostgreSQL database to store the data. The database is configured using the environment variables in the `.env` file. 

```bash
POSTGRESQL_HOST=
POSTGRESQL_PORT=
POSTGRESQL_USER=
POSTGRESQL_PASSWORD=
POSTGRESQL_DB=
```


### Redis

The server uses a Redis database to store the session data. The database is configured using the environment variables in the `.env` file. 

```bash
REDIS_HOST=
REDIS_PORT=
REDIS_PASSWORD=
```

### Proxy

The server uses a proxy to connect to the internet. The proxy is configured using the environment variables in the `.env` file. 

```bash
PROXY_URL=[socks5|http]://[username][session]:[password]@[url]:[port]
```

### Ping Pricempire

You can share the data with Pricempire by setting the `PING_PRICEMPIRE` environment variable to `true`. 

```bash
PING_PRICEMPIRE=true
```

### Refresh Stickers

You can refresh the stickers by setting the `ALLOW_REFRESH` environment variable to `true`. 

```bash
ALLOW_REFRESH=true
```

Pass `true` to the `refresh` query parameter to refresh the stickers. (This will only work if `ALLOW_REFRESH` is set to `true`) (Do not recommended to spam the endpoint with refresh requests, as it will result in a ban by the GC.)

```bash
$ curl -X GET -H "Content-Type: application/json" http://localhost:3000/?url=steam://rungame/730/76561202255233023/+csgo_econ_action_preview%20S76561198023809011A35678726741D4649654965632117657&refresh=true
```


### Logging

You can enable logging for the PostgreSQL database by setting the `POSTGRESQL_LOGGING` environment variable to `true`. 

```bash 
POSTGRESQL_LOGGING=true
```

### GameCoordiantor Logging

You can enable logging for the GameCoordiantor by setting the `GC_DEBUG` environment variable to `true`.

```bash
GC_DEBUG=true
```

### accounts.txt

The `accounts.txt` file contains the accounts that are used to authenticate the users. The file is located in the `src` directory. 

```bash
# accounts.txt
username1:password1
username2:password2
```

### .env

The `.env` file contains the environment variables that are used to configure the server. 

```bash
# .env
PORT=3000
POSTGRESQL_HOST=
POSTGRESQL_PORT=
POSTGRESQL_USER=
POSTGRESQL_PASSWORD=
POSTGRESQL_DB=
REDIS_HOST=
REDIS_PORT=
REDIS_PASSWORD=
PROXY_URL=[socks5|http]://[username][session]:[password]@[url]:[port]
POSTGRESQL_LOGGING=false
GC_DEBUG=false
PING_PRICEMPIRE=true
ALLOW_REFRESH=false
```

## Running the server

You can run the server using the following command:

```bash
$ pnpm start
```

The server will start on the port that is specified in the `.env` file.

## Development

You can run the server in development mode using the following command:

```bash
$ pnpm run start:dev
```

The server will start on the port that is specified in the `.env` file.

### API

The server has the following API endpoints:

#### GET /

This endpoint is used to inspect the data that is being sent to the server.

```bash
$ curl -X GET -H "Content-Type: application/json" http://localhost:3000/?url=steam://rungame/730/76561202255233023/+csgo_econ_action_preview%20S76561198023809011A35678726741D4649654965632117657
```

##### Response 

```json
{
    "iteminfo": {
        "stickers": [
            {
                "slot": 0,
                "stickerId": 5935,
                "codename": "csgo10_blue_gem_glitter",
                "material": "csgo10/blue_gem_glitter",
                "name": "Blue Gem (Glitter)"
            }
        ],
        "itemid": "35675800220",
        "defindex": 1209,
        "paintindex": 0,
        "rarity": 4,
        "quality": 4,
        "paintseed": 0,
        "inventory": 261,
        "origin": 8,
        "s": "76561198023809011",
        "a": "35675800220",
        "d": "12026419764860007457",
        "m": "0",
        "floatvalue": 0,
        "min": 0.06,
        "max": 0.8,
        "weapon_type": "Sticker",
        "item_name": "-",
        "rarity_name": "Remarkable",
        "quality_name": "Unique",
        "origin_name": "Found in Crate",
        "full_item_name": "Sticker | Blue Gem (Glitter)"
    }
}
```

## Importing the data from old CSFloat database

You can import the data from the old CSFloat database using the following command:

```bash
$ pnpm run import
```

Dont forget to set the `POSTGRESQL_HOST_SOURCE`, `POSTGRESQL_PORT_SOURCE`, `POSTGRESQL_USER_SOURCE`, `POSTGRESQL_PASSWORD_SOURCE`, `POSTGRESQL_DB_SOURCE` environment variables in the `.env` file.

```bash
# .env
POSTGRESQL_HOST_SOURCE=
POSTGRESQL_PORT_SOURCE=
POSTGRESQL_USER_SOURCE=
POSTGRESQL_PASSWORD_SOURCE=
POSTGRESQL_DB_SOURCE=
```

This will import the data from the old CSFloat database to the new database.


# Contributing

If you want to contribute to the project, you can do so by creating a pull request.

# License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

# Acknowledgements

- [Nest.js](https://nestjs.com/)
- [TypeORM](https://typeorm.io/)
- [Redis](https://redis.io/)
- [PostgreSQL](https://www.postgresql.org/)
- [Axios](https://axios-http.com/)
- [CS2](https://blog.counter-strike.net/)
- [node-globaloffensive](https://github.com/DoctorMcKay/node-globaloffensive)
- [node-steam-user](https://github.com/DoctorMcKay/node-steam-user) 

# Thanks To 

- [DoctorMcKay](https://github.com/DoctorMcKay)
- [CSFloat.com](https://csfloat.com/)

# Contact

If you have any questions, you can contact me at [Discord](https://discord.gg/pricempire).

