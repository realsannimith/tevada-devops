---
name: deploy-jvm
description: JVM specifics for a Docker deploy — Spring Boot, Quarkus, Micronaut, Ktor, or any Maven/Gradle project (Java, Kotlin, Scala). Use with docker-deploy whenever the app being deployed builds with Maven or Gradle (repo has pom.xml, build.gradle, or build.gradle.kts).
---

# Deploy a JVM app (Spring Boot, Quarkus, Micronaut, Ktor…)

`docker-deploy` owns the overall flow. This skill supplies the JVM specifics.
The pattern: build the jar with the project's own build tool in a JDK stage,
run it on a slim JRE stage. JVM builds are the slowest of any stack — always
raise runCommand timeoutSec to 900 for the image build.

## 1. Inspect the repo

- Build tool: `pom.xml` → Maven; `build.gradle`/`build.gradle.kts` → Gradle.
  A `mvnw`/`gradlew` wrapper in the repo pins the right version — prefer it.
- Framework: `spring-boot` in the build file → Spring Boot (port 8080);
  `quarkus` → Quarkus (8080); `micronaut` (8080); `ktor` (8080, check
  `application.conf`/embeddedServer for the actual port).
- Java version: from `<java.version>`, `sourceCompatibility`, or the toolchain
  block — match the image tags (21 shown below; use what the project pins).

## 2. Dockerfile

Maven + Spring Boot (the most common case):

```dockerfile
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /app
COPY pom.xml .
RUN mvn -q dependency:go-offline
COPY src ./src
RUN mvn -q package -DskipTests

FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /app/target/*.jar app.jar
RUN useradd -m appuser
USER appuser
ENV JAVA_OPTS="-XX:MaxRAMPercentage=75.0"
EXPOSE 8080
ENTRYPOINT ["sh", "-c", "java $JAVA_OPTS -jar app.jar"]
```

Gradle variant: builder `FROM gradle:8-jdk21 AS build`, `COPY . .`,
`RUN gradle bootJar -x test --no-daemon` (plain `jar`/`shadowJar` for
non-Spring), jar at `build/libs/*.jar`.

- `dependency:go-offline` before copying src → deps layer caches; without it
  every code change re-downloads half of Maven Central.
- `-DskipTests` in the image build — run tests separately if asked; a test
  suite needing a database will otherwise break the build.
- `MaxRAMPercentage=75` makes the JVM respect the container's memory limit
  instead of assuming the whole host.
- Quarkus builds to `target/quarkus-app/` (a directory, not one jar):
  `COPY --from=build /app/target/quarkus-app/ ./` +
  `ENTRYPOINT ["java", "-jar", "quarkus-run.jar"]`.
- Multi-module Maven project → package from the root, jar lives in
  `<module>/target/` — find it with `ls */target/*.jar` in the build stage.

## 3. Config & env

- Spring config via env works out of the box: `SERVER_PORT`,
  `SPRING_DATASOURCE_URL`, etc. map onto properties — use `--env-file`, don't
  edit application.properties inside the image.
- Needs Postgres/MySQL/Redis? Multi-container → load `docker-compose-stack`.
- **Uploads**: Spring/JVM apps saving `MultipartFile.transferTo` (or Ktor
  `File.writeBytes`) to a local dir — grep for `upload` in code and for
  `file.upload-dir`-style properties in application.properties/yml. Named
  volume over each such path (docker-deploy § "Persistent data"), or every
  redeploy erases the users' files. H2/SQLite file databases too.
- Give the container headroom: default JVM + Spring wants ≥512 MB; on a tiny
  VPS add `-m 512m` to docker run and keep MaxRAMPercentage.

## 4. Verify (in addition to docker-deploy's checks)

- Startup is slow (10–60 s): poll `sudo docker logs` until the framework's
  "Started … in Ns" / "Listening on" line appears before curling.
- Spring Boot with actuator: `curl -s http://127.0.0.1:<port>/actuator/health`
  → `{"status":"UP"}`. Otherwise curl any mapped route.
- `docker stats --no-stream <app>` — memory near the limit at idle means the
  heap flags didn't take; recheck JAVA_OPTS.
