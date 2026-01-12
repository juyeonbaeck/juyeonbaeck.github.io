---
title: Statement와 PreparedStatement의 차이
date: 2026-01-12 15:20:00 +0900
last_modified_at: 2026-01-12 15:20:00 +0900
categories: [Java]
tags: [Java, JPA]
pin: false
math: true
mermaid: true
toc: true
comments: true
share: true
related: true
read_time: true
featured: false
toc_depth: 10
thumbnail: /assets/post-img/defaultImg.gif
summary: JDBC를 공부하며, 
draft: false

image:
  path: /assets/post-img/defaultImg.gif
  alt: 이미지 설명
---

## 목차
1. 

---

## 시작하며
JDBC 라는 API의 핵심 객체 세가지 (Connection, Statement, ResultSet) 에 대해 개념을 정리하고,
Statement와 PreparedStatement의 차이에 대해서 알아본다.
그리고 해당 세가지 객체를 활용하여 실제 DB에 연결하는 코드를 작성해본다.


## 1. JDBC 란? - Java Database Connectivity
java 프로그램이 DB(oracle, mysql 등)와 연결하여 데이터를 주고 받을 수 있도록 해주는 **자바 표준 API**

- 특징: _DB 독립성_
    개발자는 JDBC 표준 사용법만 익히면, 오라클이든 MySQL이든 DB 종류에 상관없이 똑같은 자바 코드로 연결할 수 있음 (각 DB에 맞는 드라이버만 갈아 끼우면 됨)

- 역할: "자바 애플리케이션"과 "데이터베이스" 사이의 다리(Bridge) 역할

장점: 데이터베이스 관리의 편의

## 2. JDBC 핵심 객체 3개 - `Connection`, `Statement`, `ResultSet`

1. **Connection** (연결 통로)
- 역할: `DB 서버`와 `자바 프로그램` 사이의 물리적인 연결(Session)을 맺는 객체

```java
Conncetion con = null;
```
{: file="Connection.java" }

- 비유: 전화를 걸어서 상대방(DB)과 **"통화가 연결된 상태"**

- 생성: DriverManager.getConnection(url, id, pw) 메소드로 얻어옴.

- 주의: 연결을 유지하는 데 자원이 많이 소모되므로, 작업이 끝나면 반드시 .close()로 끊어줘야 함

![Connection](http://juyeonbaeck.github.io/assets/img/2026-01-12/Java_PreparedStatement_1.png)

2. **Statement** (운반 트럭)
- 역할: 연결된 통로(Connection)를 통해 SQL 문(쿼리)을 DB에 전달하고, 실행 결과를 받아오는 객체

- 비유: 주문서(SQL)를 싣고 주방(DB)으로 달리는 **"트럭"**

- 종류:
    - **Statement**: 일반 트럭 (완성된 SQL을 그대로 운반, 보안 취약)
    - **PreparedStatement**: 보안 트럭 (SQL 틀을 미리 준비하고 값만 실어 나름, 권장 👍)


3. **ResultSet** (결과 상자)
- 역할: SELECT 문을 실행했을 때, DB로부터 찾아온 **데이터 결과표(Table)**를 담고 있는 객체

- 비유: 주방(DB)에서 요리가 완료되어 나온 **"음식 쟁반"**

- 특징:
    - **커서(Cursor)**라는 것을 사용하여 데이터의 행(Row)을 하나씩 가리킴
    - .next() 메소드를 호출할 때마다 커서가 다음 줄로 이동하며 데이터를 읽음
    - (INSERT, UPDATE, DELETE는 결과가 데이터가 아니라 '몇 개 바뀌었는지' 숫자(int)로 나오므로 ResultSet을 쓰지 않음 ! => **SELECT에 사용**!)


## 3. `Statement` 와 `PreparedStatement` 차이
1. 기존 방식인 `Statement` 
: 완성된 SQL 문자열을 통째로 DB에 전송

- 단점 1 (가독성)
    변수 값을 넣을 때 따옴표(')와 더하기 기호(+)를 복잡하게 연결해야 해서 오타가 나기 쉬움
- 단점 2 (보안)
    SQL 인젝션(SQL Injection) 공격에 취약 (해커가 입력값에 SQL 명령어를 섞으면 그대로 실행됨)

```java
String name = "SCOTT";
// 문자열 결합 연산(+)으로 인해 가독성이 떨어지고, 작은따옴표(') 누락 실수가 잦음
String sql = "SELECT * FROM emp WHERE ename = '" + name + "'"; 
stmt = con.createStatement();
rs = stmt.executeQuery(sql);
```
{: file="StatementDAO.java" }

2. 개선된 방식인 `PreparedStatement`
: SQL 문장의 틀(골격)을 먼저 컴파일해두고, 실행 시에 **값(Value)**만 바꿔 끼워 넣는 방식

- 장점 1 (가독성): 복잡한 따옴표(') 처리 없음
- 장점 2 (보안): 입력값을 단순 문자로 취급하므로, SQL 인젝션을 원천 차단
- 장점 3 (성능): 동일한 쿼리는 미리 컴파일된 것을 재사용하므로 속도가 빠름

```java
PreparedStatementDAO.java
String name = "SCOTT";
// 1. SQL 작성: 값이 들어갈 자리를 물음표(?)인 'Placeholder'로 비워둠
String sql = "SELECT * FROM emp WHERE ename = ?"; 

// 2. 준비(Prepare): SQL 문법을 미리 DB에 전송하여 준비시킴
pstmt = con.prepareStatement(sql); 

// 3. 파라미터 바인딩: 첫 번째(1) 물음표(?)에 값을 채워 넣음
// 알아서 따옴표(') 처리를 해주며, 해킹 코드가 들어와도 단순 문자로 인식
pstmt.setString(1, name); 

// 4. 실행: 이미 준비된 쿼리를 실행 (괄호 안에 sql을 넣지 않음)
rs = pstmt.executeQuery();
```


## 4. DAO 란? - Data Access Object
: 데이터베이스에 접근하여 데이터를 조회하거나 조작(CRUD)하는 기능을 전담하는 **객체**
- 목적: 메인 비즈니스 로직(Controller)과 지저분한 SQL 처리 로직을 분리하기 위해 사용

### 4-1. 짝꿍: DTO (Data Transfer Object)
- DAO가 창고지기(동작, Method) 라면,
    DTO는 데이터를 담아 나르는 **이삿짐 박스(Data, Variable)** (VO 라고도 부름)

- DB에서 꺼낸 데이터를 자바 객체(DeptDTO)에 담아서 메인 프로그램으로 리턴해줌



## 5. 객체 활용 예시 코드

```java
// DeptDTO.java
// Dept(부서)의 정보를 담고있는 DB 구조

package model.domain;

// DeptDTO : 부서 테이블(dept)의 1개의 행(row) 데이터를 담는 그릇
public class DeptDTO {
    private int deptno;     // department no
    private String dname;   // department name
    private String loc;     //location
}

// 기본 생성자 (No-args Constructor)
//  - **다른 생성자가 하나도 없을 때만** 가시적으로 작성하지 않아도 자동으로 생김
//  - private으로 만들고 싶으면 : private DeptDTO() {} 라고 명시해야 함
//      -> 외부에서 new를 못 하게 막는 경우 (예: 싱글톤 패턴, 유틸리티 클래스)
//  - public DeptDTO(int deptno, ...) 처럼 파라미터가 있는 생성자를 만든 경우 (오버로딩) -> 자동으로 만들어주던 기본 생성자는 사라짐
//      -> 반드시 기본 생성자(public DeptDTO() {})를 직접 써줘야 함
//  - 생성자는 객체(Instance)를 만드는 역할이라서, 절대 static을 붙일 수 없음
public DeptDTO() {}

// 파라미터 생성자 (All-args Constructor)
public DeptDTO(int deptno, String dname, String loc) {
    this.deptno = deptno;
    this.dname = dname;
    this.loc = loc;
}

@Getter             //
@Setter             //
@AllArgsConstructor //
@NoArgsConstructor  //
@ToString           //
```
{: file="DeptDTO.java" }


```java
package model.dao;


public class DeptDAO {
    // 1. 데이터 삽입 (INSERT) - 결과가 '몇 건 처리됨(int)'으로 출력
    public boolean insertDept(DeptDTO deptdto) throws SQLException {
        Conncetion con = null;
        PreparedStatement pstmt = null;
        boolean result = false;

        try {
            con = DBUtil.getConnection();
            // 값을 넣을 곳을 ? 로 비워둠
            String sql = "INSERT INTO dept VALUES (?, ?, ?)";

            pstmt = con.preparedStatement(sql);

            //물음표 부분 채우기


        } finally {

        }

    }
}
```
{: file="DeptDAO.java" }

> [!INFO]
> **Change Log**
> - 2026-01-12: 최초 작성
> - 2026-01-12: 코드 수정
{: .prompt-info }