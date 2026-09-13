# 루틴과 자동화 알림

프롬프트에는 할 일과 시간을 적습니다. 예를 들어 “매일 오전 9시에 오늘 일정을 정리해줘”라고 요청하고, 저장 화면에서 실행 시간과 담당 크루를 확인하세요. 알림을 받을 곳은 프롬프트와 별도로 선택합니다.

## Argo 루틴

1. **루틴 → 새 루틴**을 열거나 기존 루틴을 편집합니다.
2. **알림 받을 곳**에서 텔레그램·슬랙·아르고 메신저를 여러 개 선택합니다.
3. 아르고 메신저를 선택했다면 결과를 받을 조직과 대화방을 고릅니다.
4. 저장합니다. 다음 실행부터 선택한 곳으로 결과가 전달됩니다.

선택을 모두 해제하면 추가 알림을 보내지 않습니다. 실행 기록과 원래 메신저 대화의 답글은 남습니다. 기존 루틴에 별도 선택이 없다면 기존 연결 설정을 유지합니다. **현재 연결 설정 사용**으로 표시되는 루틴도 편집해서 알림 받을 곳을 지정할 수 있습니다.

연결 설정에서 루틴 알림을 껐거나 연결이 해제됐다면 개별 루틴에서 선택해도 보내지 않습니다. 실행 성공과 알림 전달 상태는 따로 표시됩니다.

## 아르고 메신저 자동화

1. 대화방의 **업무 → 자동화**에서 새 자동화를 만들거나 편집합니다.
2. **알림 받을 곳**에서 본인에게 연결된 텔레그램·슬랙을 선택합니다. 연결이 여러 회사에 있다면 회사 이름을 확인합니다.
3. 저장합니다. 실행 결과는 원래 메신저 대화에 남고, 선택한 외부 채널에도 결과 알림을 보냅니다.

다른 사람의 크루가 실행하더라도 알림은 자동화를 만든 사람이 선택한 본인 연결로 보냅니다. 크루 사이의 논의·위임·중간 대화는 이 설정으로 외부에 복사되지 않습니다.

텔레그램·슬랙 연결 정보는 해당 Argo 기기에 보관됩니다. 그 연결이 있는 기기나 서버에서 Argo가 실행 중이어야 외부 알림을 보낼 수 있습니다. 모바일에서는 알림 받을 곳을 선택하고 상태를 확인할 수 있습니다. 기기가 잠시 꺼졌다면 최대 24시간 대기하며, 너무 늦은 알림은 만료됩니다.

**실행 이력**에서 알림이 전송됐는지, 대기 중인지, 실패했는지 확인할 수 있습니다. 전송 중 연결이 끊겨 도착 여부를 확인할 수 없는 경우에는 **확인 필요**로 표시합니다. 같은 알림이 중복 도착하지 않도록 이 경우 자동으로 다시 보내지 않습니다.

# Routine and automation notifications

Describe the work and timing in the prompt, then choose **Notification destinations** in the create or edit form. You do not need to repeat destinations in every prompt.

- **Argo → Routines:** select Telegram, Slack and/or Argo Messenger. For Messenger, select an organization and conversation. Existing routines retain their previous routing until you change it.
- **Argo Messenger → Work → Automations:** the result stays in the original conversation. Select your own Telegram or Slack connections for additional result notifications, even when someone else's crew performs the work.
- Connection-level notification mutes still apply. Routine execution and notification delivery have separate statuses.
- The Argo device or server holding an external connection must be running to send through it. Mobile can configure destinations and inspect delivery history. Offline automation notifications wait up to 24 hours, then expire.
- Uncertain delivery is marked for review and is not automatically resent. Internal crew discussions and handoffs are not copied to external channels by these settings.
