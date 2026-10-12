# Optional external Spring configuration. Not loaded by the default project template.
# Activate generator-ddl only for the forge-admin service after provisioning its CREATE-only account.
spring:
  config:
    activate:
      on-profile: generator-ddl
  datasource:
    dynamic:
      datasource:
        generatorDdl:
          type: com.zaxxer.hikari.HikariDataSource
          driverClassName: com.mysql.cj.jdbc.Driver
          # Same server and schema as normal business queries and metadata import.
          url: ${spring.datasource.dynamic.datasource.master.url}
          username: ${GENERATOR_DDL_DB_USER}
          password: ${GENERATOR_DDL_DB_PASSWORD}
          lazy: true
          hikari:
            maxPoolSize: 2
            minIdle: 0
            connectionTimeout: 5000
